/**
 * Core entrypoint for Electron utilityProcess.
 * Speaks CoreRequest / CoreResponse / CorePush over process.parentPort.
 * Same protocol can later be served over localhost WebSocket.
 */
import { Orchestrator } from "@calypso/core";
import { createBrowserControl, type BrowserControl } from "@calypso/browser";
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
  ensureInferenceRuntime,
  getInferenceRuntimeStatus,
  preloadPrimaryModel,
  PRIMARY_MODEL_KEEP_ALIVE,
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
  ModelProvider,
  ModelStatus,
  Project,
  ProjectInput,
  Team,
  TeamInput,
  WorkerId,
  WorkerInput,
  RoutineInput,
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
  const admin =
    base.id === "ollama"
      ? new OllamaAdmin({ keepAlive: PRIMARY_MODEL_KEEP_ALIVE })
      : undefined;
  const server = createSharedInferenceServer({
    provider: base,
    maxConcurrent,
    swapUnload: true,
    admin,
    refreshKeepAliveAfterInference: !!admin,
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

// Bridge agent-loop token streams onto the existing channel:"stream" IPC.
orchestrator.setStreamHandler((streamPush) => {
  push(streamPush);
});

// ---- Tools ----
const userDataRoot = path.dirname(databasePath);
const browserControl: BrowserControl = createBrowserControl({
  dataRoot: path.join(userDataRoot, "browser"),
  browsersPath: path.join(userDataRoot, "ms-playwright"),
  onRuntimeProgress: (progress) => {
    orchestrator.bus.publish({
      type: "browser.runtime.progress",
      progress,
      at: Date.now(),
    });
  },
});
for (const tool of browserControl.tools) {
  orchestrator.registerTool(tool);
}

/** Per-worker Playwright sessions (Spin): open before browse; tools take sessionId. */
const browserSessions = new Map<string, string>();

async function ensureBrowserRuntimeReady() {
  const status = await browserControl.ensureRuntime();
  orchestrator.bus.publish({
    type: "browser.runtime.ready",
    status,
    at: Date.now(),
  });
  return status;
}

/**
 * Angen: local inference first-run (Ollama detect/start + planned model pulls).
 * Publishes models.runtime.progress / models.runtime.ready on the bus, which is
 * forwarded to the renderer as calypso:event (same path as browser.runtime.*).
 * Theriz owns the UI; this is not auto-run at startup (pulls are multi-GB).
 */
async function ensureInferenceRuntimeReady() {
  const status = await ensureInferenceRuntime({ bus: orchestrator.bus });
  if (status.state === "ready") {
    void refreshModelStatus();
    // Models present — warm the resident primary in the background.
    void preloadPrimaryModelReady();
  }
  return status;
}

/**
 * Warm qwen3:8b (or configured primary) into VRAM with keep_alive so first
 * chat is ~0.4s TTFT instead of ~34s cold load. Non-blocking; emits
 * models.runtime.progress starting→ready for Theriz's banner.
 */
async function preloadPrimaryModelReady(): Promise<void> {
  await preloadPrimaryModel({ bus: orchestrator.bus });
}

async function ensureBrowserSession(workerId: string, projectId?: string): Promise<string> {
  const existing = browserSessions.get(workerId);
  if (existing) return existing;
  await ensureBrowserRuntimeReady();
  const session = await browserControl.manager.openSession({
    workerId,
    projectId,
  });
  browserSessions.set(workerId, session.id);
  return session.id;
}
for (const tool of createSystemTools()) {
  orchestrator.registerTool(tool);
}

let windowsControl: WindowsControl | null = null;
let unwatchFrames: (() => void) | null = null;

if (isWindows) {
  try {
    windowsControl = createWindowsControl({
      bus: orchestrator.bus,
      hostOptions: process.env.CALYPSO_PS_HOST_SCRIPT
        ? { scriptPath: process.env.CALYPSO_PS_HOST_SCRIPT }
        : undefined,
    });
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
      case "ensureBrowserRuntime": {
        const status = await ensureBrowserRuntimeReady();
        respond({ id: req.id, ok: true, result: status });
        return;
      }
      case "getBrowserRuntimeStatus": {
        respond({
          id: req.id,
          ok: true,
          result: await browserControl.getRuntimeStatus(),
        });
        return;
      }
      case "ensureInferenceRuntime": {
        respond({ id: req.id, ok: true, result: await ensureInferenceRuntimeReady() });
        return;
      }
      case "getInferenceRuntimeStatus": {
        respond({ id: req.id, ok: true, result: await getInferenceRuntimeStatus() });
        return;
      }
      case "preloadPrimaryModel": {
        await preloadPrimaryModelReady();
        respond({ id: req.id, ok: true, result: null });
        return;
      }
      case "listWorkers":
        respond({ id: req.id, ok: true, result: orchestrator.workers.list() });
        return;
      case "createWorker": {
        const worker = orchestrator.createWorker(req.params.worker as WorkerInput);
        orchestrator.bus.publish({ type: "worker.updated", worker });
        void ensureBrowserSession(worker.id, worker.projectId).catch(() => undefined);
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
        const saved = orchestrator.createTeam(req.params.team as TeamInput);
        respond({ id: req.id, ok: true, result: saved });
        return;
      }
      case "updateTeam": {
        const saved = orchestrator.teams.upsert(req.params.team);
        orchestrator.ensureTeamConversation(saved);
        const linked = orchestrator.teams.get(saved.id) ?? saved;
        orchestrator.bus.publish({ type: "team.updated", team: linked });
        respond({ id: req.id, ok: true, result: linked });
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
      case "listRoutines":
        respond({ id: req.id, ok: true, result: orchestrator.scheduler.list() });
        return;
      case "createRoutine": {
        const routine = orchestrator.createRoutine(req.params.routine);
        respond({ id: req.id, ok: true, result: routine });
        return;
      }
      case "updateRoutine": {
        const routine = orchestrator.updateRoutine(req.params.routine);
        respond({ id: req.id, ok: true, result: routine });
        return;
      }
      case "deleteRoutine": {
        const ok = orchestrator.deleteRoutine(req.params.routineId);
        respond({ id: req.id, ok: true, result: ok });
        return;
      }
      case "sendWorkerChat": {
        const { fromWorkerId, toWorkerIds, content, teamId, conversationId } = req.params;
        const msg = orchestrator.sendWorkerMessage(fromWorkerId, toWorkerIds, content, {
          teamId,
          conversationId,
        });
        respond({ id: req.id, ok: true, result: msg });
        return;
      }
      case "sendMessage": {
        const { conversationId, content, workerId } = req.params;
        const conversation = ensureConversation(conversationId, workerId);
        const targetId =
          workerId ??
          conversation.participantWorkerIds[0] ??
          orchestrator.workers.list()[0]?.id;
        if (targetId) {
          const worker = orchestrator.workers.get(targetId);
          if (worker) {
            void ensureBrowserSession(worker.id, worker.projectId).catch(() => undefined);
          }
        }
        const { userMessage } = await orchestrator.handleUserMessage({
          conversationId: conversation.id,
          content,
          workerId,
          teamId: conversation.teamId,
        });
        respond({ id: req.id, ok: true, result: userMessage });
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
      case "watchFrames": {
        if (windowsControl) {
          unwatchFrames?.();
          // Ensure at least one session so LiveComputerView has something to bind.
          const existing = windowsControl.controller.listSessions().find((s) => s.status !== "stopped");
          if (!existing) {
            const worker = orchestrator.workers.list()[0];
            if (worker) {
              windowsControl.controller.openSession({
                workerId: worker.id,
                objective: "Live computer view",
              });
            }
          }
          unwatchFrames = windowsControl.controller.watchFrames();
        }
        respond({
          id: req.id,
          ok: true,
          result: {
            available: !!windowsControl,
            windowsOnly: isWindows,
            sessions: windowsControl?.controller.listSessions() ?? [],
          },
        });
        return;
      }
      case "unwatchFrames":
        unwatchFrames?.();
        unwatchFrames = null;
        respond({ id: req.id, ok: true, result: null });
        return;
      case "stopAll":
        // Emergency stop: pause the agent dispatcher + halt Windows control sessions.
        orchestrator.pauseWorkers();
        windowsControl?.controller.stopAll();
        respond({ id: req.id, ok: true, result: null });
        return;
      case "pauseWorkers":
        orchestrator.pauseWorkers();
        windowsControl?.controller.pauseAll();
        respond({ id: req.id, ok: true, result: null });
        return;
      case "resumeWorkers":
        orchestrator.resumeWorkers();
        windowsControl?.controller.resumeAll();
        respond({ id: req.id, ok: true, result: null });
        return;
      case "cancelTask": {
        const task = orchestrator.cancelTask(req.params.taskId);
        respond({ id: req.id, ok: true, result: task ?? null });
        return;
      }
      case "retryTask": {
        const task = orchestrator.retryTask(req.params.taskId);
        respond({ id: req.id, ok: true, result: task ?? null });
        return;
      }
      case "openBrowserSession": {
        const { workerId, projectId } = req.params;
        const sessionId = await ensureBrowserSession(workerId, projectId);
        respond({ id: req.id, ok: true, result: { sessionId, workerId } });
        return;
      }
      case "shutdown": {
        unwatchFrames?.();
        unwatchFrames = null;
        try {
          await browserControl.dispose();
        } catch {
          /* ignore */
        }
        try {
          await windowsControl?.dispose();
        } catch {
          /* ignore */
        }
        orchestrator.close();
        respond({ id: req.id, ok: true, result: null });
        return;
      }
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
// Background: if Ollama is already up with the primary model pulled, warm it
// into VRAM (non-blocking so UI can open). Emits models.runtime.progress for Theriz.
void (async () => {
  try {
    const status = await getInferenceRuntimeStatus();
    if (status.ollamaReachable) {
      await preloadPrimaryModelReady();
    }
  } catch {
    /* never crash startup on preload failure */
  }
})();
