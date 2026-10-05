/**
 * Core entrypoint for Electron utilityProcess.
 * Speaks CoreRequest / CoreResponse / CorePush over process.parentPort.
 * Same protocol can later be served over localhost WebSocket.
 */
import { Orchestrator } from "@calypso/core";
import { BrowserSessionManager, createBrowserTools } from "@calypso/browser";
import { createSystemTools } from "@calypso/tools-system";
import {
  createWindowsControl,
  type WindowsControl,
} from "@calypso/windows-control";
import {
  DefaultModelRouter,
  createOllamaProvider,
  createSharedInferenceServer,
  OllamaAdmin,
  planFirstRunInference,
  probeHardware,
  recommendTaskClassRoutes,
  buildCompletionRequest,
  type FirstRunInferencePlan,
} from "@calypso/models";
import type {
  AppInfo,
  CalypsoEvent,
  Conversation,
  ConversationInput,
  CorePush,
  CoreRequest,
  CoreResponse,
  FirstRunPlan,
  Message,
  ModelProvider,
  ModelStatus,
  Project,
  ProjectInput,
  Team,
  TeamInput,
  Worker,
  WorkerId,
  WorkerInput,
} from "@calypso/shared";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const VERSION = "0.1.0";

function respond(msg: CoreResponse): void {
  process.parentPort?.postMessage(msg);
}

function push(msg: CorePush): void {
  process.parentPort?.postMessage(msg);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveDatabasePath(): string {
  const fromEnv = process.env.CALYPSO_DATABASE_PATH?.trim();
  if (fromEnv) {
    fs.mkdirSync(path.dirname(fromEnv), { recursive: true });
    return fromEnv;
  }
  const root = path.join(os.homedir(), ".calypso");
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, "calypso.sqlite");
}

/** Wrap SharedInferenceServer so the ModelRouter still sees a ModelProvider. */
function queuedProvider(
  base: ModelProvider,
  maxConcurrent: number
): ModelProvider {
  const admin = base.id === "ollama" ? new OllamaAdmin() : undefined;
  const server = createSharedInferenceServer({
    provider: base,
    maxConcurrent,
    swapUnload: true,
    admin,
  });
  return {
    id: base.id,
    displayName: base.displayName,
    listModels: () => base.listModels(),
    isReady: () => base.isReady(),
    complete: (req) => server.complete(req),
    stream: (req, signal) => server.stream(req, signal),
  };
}

const databasePath = resolveDatabasePath();
const isWindows = process.platform === "win32";

const ollamaBase = createOllamaProvider();
let modelReady = false;
let modelStatusMessage = "Checking local model runtime…";

const router = new DefaultModelRouter();
// Register immediately so resolve() works; readiness is probed async.
router.registerProvider(queuedProvider(ollamaBase, 1));

let hardwareRoutesApplied = false;

async function ensureRoutes(): Promise<void> {
  if (hardwareRoutesApplied) return;
  hardwareRoutesApplied = true;
  try {
    const profile = await probeHardware();
    const routes = recommendTaskClassRoutes(profile);
    const concurrent = profile.gpuDetected ? 1 : Math.min(2, Math.max(1, Math.floor(profile.cpuCores / 4)));
    // Re-register with concurrency tuned to hardware.
    router.registerProvider(queuedProvider(ollamaBase, concurrent));
    for (const [taskClass, rec] of Object.entries(routes) as Array<
      [keyof typeof routes, (typeof routes)[keyof typeof routes]]
    >) {
      if (rec.providerId === "ollama") {
        router.setRoute(taskClass, "ollama", rec.model);
      }
    }
  } catch (err) {
    // Fallback routes so chat can still attempt Ollama defaults.
    router.setRoute("simple", "ollama", "qwen2.5:0.5b");
    router.setRoute("normal", "ollama", "qwen3:8b");
    router.setRoute("code", "ollama", "qwen3:8b");
    router.setRoute("vision", "ollama", "qwen2.5vl:3b");
    router.setRoute("reasoning", "ollama", "qwen3:8b");
    modelStatusMessage =
      err instanceof Error ? err.message : "Hardware probe failed; using default routes";
  }
}

async function refreshModelStatus(): Promise<ModelStatus> {
  await ensureRoutes();
  try {
    modelReady = await ollamaBase.isReady();
    modelStatusMessage = modelReady
      ? "Ollama is reachable"
      : "Ollama is not reachable — chat will report the model as unavailable";
  } catch (err) {
    modelReady = false;
    modelStatusMessage =
      err instanceof Error
        ? err.message
        : "Ollama is not reachable — chat will report the model as unavailable";
  }
  return {
    ready: modelReady,
    providerId: "ollama",
    displayName: "Ollama",
    message: modelStatusMessage,
  };
}

// Kick off readiness in background — never block process start.
void refreshModelStatus();

const orchestrator = new Orchestrator({
  databasePath,
  modelRouter: router,
  // Embeddings hit Ollama; disable auto-fail when Ollama is down.
  disableEmbeddings: true,
});

orchestrator.bus.subscribe((event: CalypsoEvent) => {
  push({ channel: "event", event });
});

// ---- Tools ----
const browserManager = new BrowserSessionManager({
  dataRoot: path.join(path.dirname(databasePath), "browser-profiles"),
});
for (const tool of createBrowserTools(browserManager)) {
  orchestrator.registerTool(tool);
}
for (const tool of createSystemTools()) {
  orchestrator.registerTool(tool);
}

let windowsControl: WindowsControl | null = null;
let unwatchFrames: (() => void) | null = null;
let workersPaused = false;

if (isWindows) {
  try {
    windowsControl = createWindowsControl({ bus: orchestrator.bus });
    for (const tool of windowsControl.tools) {
      orchestrator.registerTool(tool);
    }
  } catch (err) {
    push({
      channel: "event",
      event: {
        type: "system.error",
        message: "Windows control failed to initialize",
        cause: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      },
    });
    windowsControl = null;
  }
} else {
  // Construct on Linux so StubPowerShellHost is exercised, but do not register
  // tools — feature is reported unavailable via getAppInfo.
  try {
    windowsControl = createWindowsControl({ bus: orchestrator.bus });
  } catch {
    windowsControl = null;
  }
}

function toFirstRunPlan(plan: FirstRunInferencePlan): FirstRunPlan {
  return {
    gpuDetected: plan.gpuDetected,
    gpuName: plan.profile.gpuName,
    vramGb: plan.profile.vramGb,
    cpuCores: plan.profile.cpuCores,
    totalMemoryGb: plan.profile.totalMemoryGb,
    modelsToDownload: plan.modelsToDownload.map((m) => ({
      model: m.model,
      purpose: m.purpose,
      estimatedDownloadMb: m.estimatedDownloadMb,
      usedBy: m.usedBy,
    })),
    embedding: {
      model: plan.embedding.model,
      estimatedDownloadMb: plan.embedding.estimatedDownloadMb,
      notes: plan.embedding.notes,
    },
    notes: plan.notes,
    visionSwapPolicy: plan.visionSwapPolicy,
  };
}

function upsertConversation(input: ConversationInput | Conversation): Conversation {
  const now = Date.now();
  const conversation: Conversation = {
    ...input,
    createdAt: "createdAt" in input && input.createdAt ? input.createdAt : now,
    updatedAt: now,
  };
  orchestrator.database?.upsertConversation(conversation);
  orchestrator.bus.publish({ type: "conversation.updated", conversation });
  return conversation;
}

function ensureConversation(id: string, workerId?: WorkerId): Conversation {
  const existing = orchestrator.database?.listConversations().find((c) => c.id === id);
  if (existing) return existing;
  return upsertConversation({
    id,
    title: "Conversation",
    participantWorkerIds: workerId ? [workerId] : [],
  });
}

async function streamWorkerReply(
  conversationId: string,
  worker: Worker,
  userContent: string
): Promise<void> {
  const messageId = newId("msg");
  const status = await refreshModelStatus();
  if (!status.ready) {
    const content =
      "The local model runtime (Ollama) is unavailable. Start Ollama and pull the recommended models from Setup, then try again.";
    const message: Message = {
      id: messageId,
      conversationId,
      author: { type: "system" },
      content,
      createdAt: Date.now(),
    };
    orchestrator.recordMessage(message);
    push({
      channel: "stream",
      conversationId,
      messageId,
      delta: content,
      done: true,
    });
    return;
  }

  if (workersPaused) {
    const content = "Workers are paused. Resume from the tray menu to continue.";
    const message: Message = {
      id: messageId,
      conversationId,
      author: { type: "system" },
      content,
      createdAt: Date.now(),
    };
    orchestrator.recordMessage(message);
    push({
      channel: "stream",
      conversationId,
      messageId,
      delta: content,
      done: true,
    });
    return;
  }

  orchestrator.workers.setStatus(worker.id, "thinking");
  orchestrator.bus.publish({
    type: "worker.status",
    workerId: worker.id,
    status: "thinking",
    at: Date.now(),
  });

  let full = "";
  try {
    const taskClass =
      typeof worker.preferredModel === "string" &&
      ["simple", "normal", "code", "vision", "reasoning", "frontier"].includes(
        worker.preferredModel
      )
        ? (worker.preferredModel as "normal")
        : "normal";
    const { provider, model } = await router.resolve(taskClass, worker.preferredModel);
    const history = orchestrator.database?.listMessages(conversationId) ?? [];
    const messages = [
      {
        role: "system" as const,
        content: [
          `You are ${worker.name}, a Calypso worker.`,
          `Role: ${worker.role}`,
          `Personality: ${worker.personality}`,
          worker.instructions,
        ]
          .filter(Boolean)
          .join("\n"),
      },
      ...history.slice(-20).map((m) => ({
        role:
          m.author.type === "user"
            ? ("user" as const)
            : m.author.type === "worker"
              ? ("assistant" as const)
              : ("system" as const),
        content: m.content,
      })),
      { role: "user" as const, content: userContent },
    ];

    const request = buildCompletionRequest(
      { model, messages, temperature: 0.7, stream: true },
      taskClass
    );

    for await (const chunk of provider.stream(request)) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) continue;
      full += delta;
      push({
        channel: "stream",
        conversationId,
        messageId,
        delta,
        done: false,
        workerId: worker.id,
      });
    }

    const message: Message = {
      id: messageId,
      conversationId,
      author: { type: "worker", workerId: worker.id },
      content: full || "(empty reply)",
      createdAt: Date.now(),
    };
    orchestrator.recordMessage(message);
    push({
      channel: "stream",
      conversationId,
      messageId,
      delta: "",
      done: true,
      workerId: worker.id,
    });
  } catch (err) {
    const content = `Model error: ${err instanceof Error ? err.message : String(err)}`;
    const message: Message = {
      id: messageId,
      conversationId,
      author: { type: "system" },
      content,
      createdAt: Date.now(),
    };
    orchestrator.recordMessage(message);
    push({
      channel: "stream",
      conversationId,
      messageId,
      delta: content,
      done: true,
      workerId: worker.id,
    });
  } finally {
    orchestrator.workers.setStatus(worker.id, "idle");
    orchestrator.bus.publish({
      type: "worker.status",
      workerId: worker.id,
      status: "idle",
      at: Date.now(),
    });
  }
}

process.parentPort?.on("message", (event) => {
  void handle(event.data as CoreRequest);
});

async function handle(req: CoreRequest): Promise<void> {
  try {
    switch (req.method) {
      case "getAppInfo": {
        const modelStatus = await refreshModelStatus();
        const result: AppInfo = {
          name: "Calypso",
          version: VERSION,
          platform: process.platform,
          modelStatus,
          windowsControlAvailable: isWindows && !!windowsControl,
        };
        respond({ id: req.id, ok: true, result });
        return;
      }
      case "getModelStatus":
        respond({ id: req.id, ok: true, result: await refreshModelStatus() });
        return;
      case "getFirstRunPlan": {
        const profile = await probeHardware();
        const plan = planFirstRunInference(profile);
        respond({ id: req.id, ok: true, result: toFirstRunPlan(plan) });
        return;
      }
      case "listWorkers":
        respond({ id: req.id, ok: true, result: orchestrator.workers.list() });
        return;
      case "createWorker": {
        const worker = orchestrator.createWorker(req.params.worker as WorkerInput);
        orchestrator.bus.publish({ type: "worker.updated", worker });
        respond({ id: req.id, ok: true, result: worker });
        return;
      }
      case "updateWorker": {
        const worker = orchestrator.workers.upsert(req.params.worker);
        orchestrator.bus.publish({ type: "worker.updated", worker });
        respond({ id: req.id, ok: true, result: worker });
        return;
      }
      case "listTeams":
        respond({ id: req.id, ok: true, result: orchestrator.teams.list() });
        return;
      case "createTeam": {
        const now = Date.now();
        const input = req.params.team as TeamInput;
        const team: Team = {
          ...input,
          createdAt: input.createdAt ?? now,
          updatedAt: now,
        };
        const saved = orchestrator.teams.upsert(team);
        respond({ id: req.id, ok: true, result: saved });
        return;
      }
      case "updateTeam": {
        const saved = orchestrator.teams.upsert(req.params.team);
        respond({ id: req.id, ok: true, result: saved });
        return;
      }
      case "listProjects":
        respond({ id: req.id, ok: true, result: orchestrator.projects.list() });
        return;
      case "createProject": {
        const now = Date.now();
        const input = req.params.project as ProjectInput;
        const project: Project = {
          ...input,
          createdAt: input.createdAt ?? now,
          updatedAt: now,
        };
        const saved = orchestrator.projects.upsert(project);
        orchestrator.bus.publish({ type: "project.updated", project: saved });
        respond({ id: req.id, ok: true, result: saved });
        return;
      }
      case "updateProject": {
        const saved = orchestrator.projects.upsert(req.params.project);
        orchestrator.bus.publish({ type: "project.updated", project: saved });
        respond({ id: req.id, ok: true, result: saved });
        return;
      }
      case "listConversations":
        respond({
          id: req.id,
          ok: true,
          result: orchestrator.database?.listConversations() ?? [],
        });
        return;
      case "createConversation": {
        const conversation = upsertConversation(req.params.conversation);
        respond({ id: req.id, ok: true, result: conversation });
        return;
      }
      case "updateConversation": {
        const conversation = upsertConversation(req.params.conversation);
        respond({ id: req.id, ok: true, result: conversation });
        return;
      }
      case "listMessages":
        respond({
          id: req.id,
          ok: true,
          result: orchestrator.database?.listMessages(req.params.conversationId) ?? [],
        });
        return;
      case "getTaskGraph":
        respond({ id: req.id, ok: true, result: orchestrator.tasks.snapshot() });
        return;
      case "sendMessage": {
        const { conversationId, content, workerId } = req.params;
        const conversation = ensureConversation(conversationId, workerId);
        const message: Message = {
          id: newId("msg"),
          conversationId: conversation.id,
          author: { type: "user" },
          content,
          createdAt: Date.now(),
        };
        orchestrator.recordMessage(message);
        respond({ id: req.id, ok: true, result: message });

        const targetId =
          workerId ??
          conversation.participantWorkerIds[0] ??
          orchestrator.workers.list()[0]?.id;
        const worker = targetId ? orchestrator.workers.get(targetId) : undefined;
        if (worker) {
          void streamWorkerReply(conversation.id, worker, content);
        } else {
          const sys: Message = {
            id: newId("msg"),
            conversationId: conversation.id,
            author: { type: "system" },
            content: "No worker available to reply. Create a worker first.",
            createdAt: Date.now(),
          };
          orchestrator.recordMessage(sys);
        }
        return;
      }
      case "resolvePermission":
        orchestrator.gate.resolve(req.params.requestId, req.params.allow);
        respond({ id: req.id, ok: true, result: null });
        return;
      case "controlCommand":
        if (windowsControl && isWindows) {
          await windowsControl.controller.handleCommand(req.params.command);
        } else {
          orchestrator.bus.publish({
            type: "control.session.command",
            command: req.params.command,
          });
        }
        respond({ id: req.id, ok: true, result: null });
        return;
      case "watchFrames":
        if (windowsControl && isWindows) {
          unwatchFrames?.();
          unwatchFrames = windowsControl.controller.watchFrames();
        }
        respond({ id: req.id, ok: true, result: null });
        return;
      case "unwatchFrames":
        unwatchFrames?.();
        unwatchFrames = null;
        respond({ id: req.id, ok: true, result: null });
        return;
      case "stopAll":
        windowsControl?.controller.stopAll();
        respond({ id: req.id, ok: true, result: null });
        return;
      case "pauseWorkers":
        workersPaused = true;
        windowsControl?.controller.pauseAll();
        for (const w of orchestrator.workers.list()) {
          if (w.status !== "offline" && w.status !== "error") {
            orchestrator.workers.setStatus(w.id, "waiting");
            orchestrator.bus.publish({
              type: "worker.status",
              workerId: w.id,
              status: "waiting",
              at: Date.now(),
            });
          }
        }
        respond({ id: req.id, ok: true, result: null });
        return;
      case "resumeWorkers":
        workersPaused = false;
        windowsControl?.controller.resumeAll();
        for (const w of orchestrator.workers.list()) {
          if (w.status === "waiting") {
            orchestrator.workers.setStatus(w.id, "idle");
            orchestrator.bus.publish({
              type: "worker.status",
              workerId: w.id,
              status: "idle",
              at: Date.now(),
            });
          }
        }
        respond({ id: req.id, ok: true, result: null });
        return;
      default:
        respond({
          id: (req as { id: string }).id,
          ok: false,
          error: `Unknown method`,
        });
    }
  } catch (err) {
    respond({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Core process online; database at CALYPSO_DATABASE_PATH / default.
