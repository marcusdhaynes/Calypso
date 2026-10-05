import path from "node:path";
import type {
  Conversation,
  ConversationId,
  CoreStreamPush,
  EmbeddingProvider,
  Message,
  ModelRouter,
  Plan,
  Routine,
  RoutineInput,
  Task,
  TaskId,
  Team,
  TeamId,
  TeamInput,
  Tool,
  ToolCall,
  ToolResult,
  Worker,
  WorkerId,
} from "@calypso/shared";
import { createLocalEmbeddingProvider } from "@calypso/models";
import { InProcessEventBus } from "../bus/event-bus.js";
import { PersistentTaskGraph } from "../task-graph/task-graph.js";
import { WorkerRegistry } from "../workers/registry.js";
import { TeamRegistry } from "../teams/teams.js";
import { ProjectRegistry } from "../projects/projects.js";
import { SqliteMemoryStore } from "../memory/sqlite-memory-store.js";
import { InMemoryMemoryStore } from "../memory/memory-store.js";
import { RoutineScheduler } from "../scheduler/scheduler.js";
import { DefaultPermissionGate } from "../permissions/gate.js";
import { CalypsoDatabase, defaultDatabasePath } from "../db/database.js";
import { ArtifactRegistry } from "../artifacts/registry.js";
import type { MemoryStore } from "@calypso/shared";
import { TaskDispatcher } from "../runtime/dispatcher.js";
import { Planner } from "../runtime/planner.js";
import { WorkerRuntime } from "../runtime/worker-runtime.js";
import { createTeamTools } from "../runtime/team-tools.js";
import { newId } from "../runtime/ids.js";

export interface OrchestratorOptions {
  /** Path to calypso.sqlite, or ":memory:" for tests. Defaults to in-memory if omitted. */
  databasePath?: string;
  /** User-data root used when databasePath is omitted and persist=true. */
  userDataRoot?: string;
  /** When true and no databasePath, persist under userDataRoot/calypso.sqlite. */
  persist?: boolean;
  modelRouter?: ModelRouter;
  embeddings?: EmbeddingProvider;
  /** Skip auto-creating local embeddings (useful in unit tests). */
  disableEmbeddings?: boolean;
  /** Dispatcher concurrency (default 2). */
  concurrency?: number;
  /** When false, do not auto-start the background dispatcher (tests may start manually). Default true. */
  autoStartDispatcher?: boolean;
}

export interface HandleUserMessageInput {
  conversationId: ConversationId;
  content: string;
  /** Optional worker to address; otherwise first conversation participant / team lead. */
  workerId?: WorkerId;
  /** When set (or conversation.teamId), use the team planner. */
  teamId?: TeamId;
}

export interface HandleUserMessageResult {
  userMessage: Message;
  /** Root task created for this request (plan root or single worker task). */
  task: Task;
  /** All tasks materialized (root + steps when planned). */
  tasks: Task[];
}

/**
 * Top-level orchestration façade.
 * Intended to run inside an Electron utilityProcess (see apps/desktop).
 *
 * Persistence: better-sqlite3 via CalypsoDatabase when a path is provided.
 * Memory retrieve uses Angen's createLocalEmbeddingProvider when available.
 *
 * Agent runtime: TaskDispatcher + WorkerRuntime + Planner. Desktop should call
 * `handleUserMessage` (or createTask + dispatcher.kick) instead of a monolithic
 * one-shot model prompt, and register `setStreamHandler` for token streaming.
 */
export class Orchestrator {
  readonly bus = new InProcessEventBus();
  readonly database: CalypsoDatabase | undefined;
  readonly tasks: PersistentTaskGraph;
  readonly workers: WorkerRegistry;
  readonly teams: TeamRegistry;
  readonly projects: ProjectRegistry;
  readonly memory: MemoryStore;
  readonly scheduler: RoutineScheduler;
  readonly artifacts: ArtifactRegistry;
  readonly gate: DefaultPermissionGate;
  readonly modelRouter: ModelRouter | undefined;
  readonly embeddings: EmbeddingProvider | undefined;
  readonly dispatcher: TaskDispatcher;
  readonly planner: Planner;
  readonly runtime: WorkerRuntime;

  private tools = new Map<string, Tool>();
  private streamHandler: ((push: CoreStreamPush) => void) | undefined;
  private workersPaused = false;

  constructor(opts: OrchestratorOptions = {}) {
    this.modelRouter = opts.modelRouter;

    const dbPath =
      opts.databasePath ??
      (opts.persist && opts.userDataRoot
        ? defaultDatabasePath(opts.userDataRoot)
        : undefined);

    if (dbPath) {
      this.database = new CalypsoDatabase({ filePath: dbPath });
    }

    this.embeddings =
      opts.embeddings ??
      (opts.disableEmbeddings ? undefined : createLocalEmbeddingProvider());

    this.workers = new WorkerRegistry(this.database);
    this.teams = new TeamRegistry(this.database);
    this.projects = new ProjectRegistry(this.database);
    this.tasks = new PersistentTaskGraph(this.database);
    this.scheduler = new RoutineScheduler(this.database);
    const artifactsRoot =
      opts.userDataRoot
        ? path.join(opts.userDataRoot, "artifacts")
        : dbPath && dbPath !== ":memory:"
          ? path.join(path.dirname(dbPath), "artifacts")
          : path.join(process.cwd(), ".calypso-artifacts");
    this.artifacts = new ArtifactRegistry({
      database: this.database,
      artifactsRoot,
      bus: this.bus,
    });
    this.memory = this.database
      ? new SqliteMemoryStore(this.database, this.embeddings)
      : new InMemoryMemoryStore();
    this.gate = new DefaultPermissionGate(this.bus);

    this.runtime = new WorkerRuntime(this);
    this.planner = new Planner(this);
    this.dispatcher = new TaskDispatcher(this, {
      concurrency: opts.concurrency ?? 2,
      onStream: (push) => this.streamHandler?.(push),
    });

    for (const tool of createTeamTools(this)) {
      this.registerTool(tool);
    }

    this.scheduler.start((routine) => {
      const team = routine.teamId ? this.teams.get(routine.teamId) : undefined;
      const conversationId = team?.conversationId;
      const task = this.createTask({
        id: newId("task"),
        title: routine.taskTemplate.title,
        description: routine.taskTemplate.description,
        status: "pending",
        parentId: null,
        dependsOn: [],
        assignedWorkerId: routine.workerId,
        projectId: routine.projectId,
        teamId: routine.teamId,
        conversationId,
        taskClass: routine.taskTemplate.taskClass,
      });
      this.bus.publish({
        type: "routine.fired",
        routineId: routine.id,
        taskId: task.id,
        at: Date.now(),
      });
      this.dispatcher.kick();
    });

    if (opts.autoStartDispatcher !== false) {
      this.dispatcher.start();
    }
  }

  /** Register a callback for CoreStreamPush token deltas (desktop bridges to IPC). */
  setStreamHandler(handler: ((push: CoreStreamPush) => void) | undefined): void {
    this.streamHandler = handler;
    this.dispatcher.setStreamHandler(handler ? (p) => handler(p) : undefined);
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listTools(): Tool[] {
    return [...this.tools.values()];
  }

  createWorker(partial: Omit<Worker, "createdAt" | "updatedAt" | "status"> & { status?: Worker["status"] }): Worker {
    const now = Date.now();
    return this.workers.upsert({
      ...partial,
      status: partial.status ?? "idle",
      createdAt: now,
      updatedAt: now,
    });
  }

  createTask(
    partial: Omit<Task, "childIds" | "createdAt" | "updatedAt"> & { childIds?: TaskId[] },
    opts?: { deferDispatch?: boolean }
  ): Task {
    const now = Date.now();
    const task: Task = {
      ...partial,
      childIds: partial.childIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
    const saved = this.tasks.upsert(task);
    this.bus.publish({ type: "task.created", task: saved });
    if (!opts?.deferDispatch) this.dispatcher.kick();
    return saved;
  }

  /**
   * Expand an approved Plan into the task graph (parent root + step children).
   * Children with no step deps start with empty dependsOn (not blocked on root).
   * Root is left pending/waiting; dispatcher marks it completed when children finish.
   */
  materializePlan(plan: Plan, assignedWorkerId?: WorkerId): Task[] {
    const root = this.createTask(
      {
        id: `task_plan_${plan.id}`,
        title: plan.title,
        description: plan.goal,
        status: "waiting",
        parentId: null,
        dependsOn: [],
        assignedWorkerId,
        planId: plan.id,
        projectId: plan.projectId,
        taskClass: "reasoning",
      },
      { deferDispatch: true }
    );

    const stepTasks: Task[] = [];
    const stepIdToTaskId = new Map<string, TaskId>();

    for (const step of plan.steps) {
      const id = `task_step_${plan.id}_${step.id}`;
      stepIdToTaskId.set(step.id, id);
    }

    for (const step of plan.steps) {
      const id = stepIdToTaskId.get(step.id)!;
      const dependsOn = step.dependsOnStepIds
        .map((sid) => stepIdToTaskId.get(sid))
        .filter((x): x is TaskId => !!x);
      const child = this.createTask(
        {
          id,
          title: step.title,
          description: step.description,
          status: "pending",
          parentId: root.id,
          dependsOn,
          assignedWorkerId: step.suggestedWorkerId ?? assignedWorkerId,
          planId: plan.id,
          projectId: plan.projectId,
          taskClass: step.taskClass,
        },
        { deferDispatch: true }
      );
      stepTasks.push(child);
    }

    const updatedRoot = this.tasks.upsert({
      ...root,
      childIds: stepTasks.map((t) => t.id),
      updatedAt: Date.now(),
    });

    this.bus.publish({ type: "plan.updated", plan: { ...plan, status: "executing" } });
    this.dispatcher.kick();
    return [updatedRoot, ...stepTasks];
  }

  /**
   * Plan → Execute → Observe → Verify for a single tool call.
   * Gate is checked before side effects; ActionResult-style verification is caller-supplied.
   */
  async executeToolCall(
    worker: Worker,
    toolCall: ToolCall,
    verify?: (result: ToolResult) => Promise<{ ok: boolean; detail?: string }>
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.toolName);
    if (!tool) {
      return {
        toolCallId: toolCall.id,
        ok: false,
        error: `Unknown tool: ${toolCall.toolName}`,
        durationMs: 0,
      };
    }

    const decision = await this.gate.check(worker, toolCall);
    if (decision.decision === "deny") {
      return {
        toolCallId: toolCall.id,
        ok: false,
        error: decision.reason,
        durationMs: 0,
      };
    }

    const started = Date.now();
    this.workers.setStatus(worker.id, statusForTool(tool.toolClass));
    this.bus.publish({
      type: "worker.status",
      workerId: worker.id,
      status: statusForTool(tool.toolClass),
      at: Date.now(),
    });
    try {
      this.bus.publish({
        type: "tool.progress",
        progress: {
          toolCallId: toolCall.id,
          toolName: tool.name,
          workerId: worker.id,
          message: `Running ${tool.name}…`,
          percent: 0,
        },
      });
      const result = await tool.execute(toolCall.params, {
        toolCallId: toolCall.id,
        workerId: worker.id,
        worker,
        taskId: toolCall.taskId,
        gate: this.gate,
        onProgress: (progress) =>
          this.bus.publish({
            type: "tool.progress",
            progress: {
              ...progress,
              toolName: progress.toolName ?? tool.name,
              workerId: progress.workerId ?? worker.id,
            },
          }),
      });

      let finalResult: ToolResult = {
        ...result,
        toolName: result.toolName ?? tool.name,
        workerId: result.workerId ?? worker.id,
        durationMs: result.durationMs || Date.now() - started,
      };
      if (verify) {
        const v = await verify(finalResult);
        if (!v.ok) {
          finalResult = {
            ...finalResult,
            ok: false,
            error: v.detail ?? "Verification failed after tool execution",
          };
        }
      }

      this.bus.publish({ type: "tool.result", result: finalResult });
      try {
        this.artifacts.captureFromTool(worker, toolCall, finalResult);
      } catch {
        // artifact capture is best-effort
      }
      return finalResult;
    } catch (err) {
      // A throwing tool must not abort the whole agent loop: hand the error
      // back to the model as a failed tool result so it can recover.
      const failed: ToolResult = {
        toolCallId: toolCall.id,
        toolName: tool.name,
        workerId: worker.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
      this.bus.publish({ type: "tool.result", result: failed });
      return failed;
    } finally {
      this.workers.setStatus(worker.id, "idle");
      this.bus.publish({
        type: "worker.status",
        workerId: worker.id,
        status: "idle",
        at: Date.now(),
      });
    }
  }

  /**
   * Drain ready tasks (legacy helper). Prefer the background TaskDispatcher.
   * Marks ready leaf tasks as running and returns them; does not execute the agent loop.
   */
  async pump(max = 8): Promise<Task[]> {
    const ready = this.tasks
      .readyTasks()
      .filter((t) => t.childIds.length === 0)
      .slice(0, max);
    for (const t of ready) {
      this.tasks.setStatus(t.id, "running");
      this.bus.publish({
        type: "task.status",
        taskId: t.id,
        status: "running",
        at: Date.now(),
      });
    }
    return ready;
  }

  completeTask(id: TaskId, result?: string): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const updated = this.tasks.upsert({
      ...t,
      status: "completed",
      result,
      updatedAt: Date.now(),
      completedAt: Date.now(),
    });
    this.bus.publish({ type: "task.updated", task: updated });
    this.bus.publish({
      type: "task.status",
      taskId: id,
      status: "completed",
      at: Date.now(),
    });
    return updated;
  }

  failTask(id: TaskId, error: string): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const updated = this.tasks.upsert({
      ...t,
      status: "failed",
      error,
      updatedAt: Date.now(),
      completedAt: Date.now(),
    });
    this.bus.publish({ type: "task.updated", task: updated });
    this.bus.publish({
      type: "task.status",
      taskId: id,
      status: "failed",
      at: Date.now(),
    });
    return updated;
  }

  failTaskCancelled(id: TaskId): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const updated = this.tasks.upsert({
      ...t,
      status: "cancelled",
      error: "Cancelled",
      updatedAt: Date.now(),
      completedAt: Date.now(),
    });
    this.bus.publish({ type: "task.updated", task: updated });
    this.bus.publish({
      type: "task.status",
      taskId: id,
      status: "cancelled",
      at: Date.now(),
    });
    return updated;
  }

  cancelTask(id: TaskId): Task | undefined {
    return this.dispatcher.cancel(id);
  }

  retryTask(id: TaskId): Task | undefined {
    return this.dispatcher.retry(id);
  }

  pauseWorkers(): void {
    this.workersPaused = true;
    this.dispatcher.pause();
    for (const w of this.workers.list()) {
      if (w.status !== "offline" && w.status !== "error") {
        this.workers.setStatus(w.id, "waiting");
        this.bus.publish({
          type: "worker.status",
          workerId: w.id,
          status: "waiting",
          at: Date.now(),
        });
      }
    }
  }

  resumeWorkers(): void {
    this.workersPaused = false;
    this.dispatcher.resume();
    for (const w of this.workers.list()) {
      if (w.status === "waiting") {
        this.workers.setStatus(w.id, "idle");
        this.bus.publish({
          type: "worker.status",
          workerId: w.id,
          status: "idle",
          at: Date.now(),
        });
      }
    }
  }

  get areWorkersPaused(): boolean {
    return this.workersPaused;
  }

  recordMessage(message: Message): Message {
    this.database?.upsertMessage(message);
    this.bus.publish({ type: "message.created", message });
    return message;
  }

  /**
   * Create or return the shared group-chat conversation for a team.
   * Links `team.conversationId` and keeps participantWorkerIds in sync.
   */
  ensureTeamConversation(team: Team): Conversation {
    const now = Date.now();
    if (team.conversationId && this.database) {
      const existing = this.database
        .listConversations()
        .find((c) => c.id === team.conversationId);
      if (existing) {
        const merged: Conversation = {
          ...existing,
          participantWorkerIds: [...new Set([...existing.participantWorkerIds, ...team.memberIds])],
          teamId: team.id,
          projectId: team.projectId ?? existing.projectId,
          title: existing.title || `${team.name} chat`,
          updatedAt: now,
        };
        this.database.upsertConversation(merged);
        this.bus.publish({ type: "conversation.updated", conversation: merged });
        return merged;
      }
    }

    const conversation: Conversation = {
      id: team.conversationId ?? newId("conv"),
      title: `${team.name} chat`,
      participantWorkerIds: [...team.memberIds],
      teamId: team.id,
      projectId: team.projectId,
      createdAt: now,
      updatedAt: now,
    };
    this.database?.upsertConversation(conversation);
    this.bus.publish({ type: "conversation.updated", conversation });

    if (team.conversationId !== conversation.id) {
      const linked = this.teams.upsert({
        ...team,
        conversationId: conversation.id,
        updatedAt: now,
      });
      this.bus.publish({ type: "team.updated", team: linked });
    }
    return conversation;
  }

  /** Upsert a team and ensure its group-chat conversation exists. */
  createTeam(input: TeamInput): Team {
    const now = Date.now();
    const team: Team = {
      ...input,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    const saved = this.teams.upsert(team);
    this.ensureTeamConversation(saved);
    const linked = this.teams.get(saved.id) ?? saved;
    this.bus.publish({ type: "team.updated", team: linked });
    return linked;
  }

  listArtifacts() {
    return this.artifacts.list();
  }

  createArtifact(input: Parameters<ArtifactRegistry["create"]>[0]) {
    return this.artifacts.create(input);
  }

  deleteArtifact(id: string): boolean {
    return this.artifacts.delete(id);
  }

  createRoutine(input: RoutineInput): Routine {
    const now = Date.now();
    const routine = this.scheduler.upsert({
      ...input,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      enabled: input.enabled ?? true,
    });
    this.bus.publish({ type: "routine.updated", routine });
    return routine;
  }

  updateRoutine(routine: Routine): Routine {
    const saved = this.scheduler.upsert({ ...routine, updatedAt: Date.now() });
    this.bus.publish({ type: "routine.updated", routine: saved });
    return saved;
  }

  deleteRoutine(id: string): boolean {
    return this.scheduler.delete(id);
  }

  /**
   * Persist + publish a worker-to-worker message (bus.chat) into the team conversation.
   * Resolves conversationId from opts, team.conversationId, or ensureTeamConversation.
   */
  sendWorkerMessage(
    fromWorkerId: WorkerId,
    toWorkerIds: WorkerId[],
    content: string,
    opts?: { taskId?: TaskId; conversationId?: ConversationId; teamId?: TeamId }
  ): Message | undefined {
    const from = this.workers.get(fromWorkerId);
    const teamId = opts?.teamId ?? from?.teamId;
    const team = teamId ? this.teams.get(teamId) : undefined;

    let conversationId = opts?.conversationId ?? team?.conversationId;
    if (!conversationId && team) {
      conversationId = this.ensureTeamConversation(team).id;
    }

    this.bus.publish({
      type: "bus.chat",
      fromWorkerId,
      toWorkerIds,
      teamId,
      content,
      taskId: opts?.taskId,
      at: Date.now(),
    });

    if (!conversationId) return undefined;

    const addressed =
      toWorkerIds.length > 0
        ? `[@${toWorkerIds.map((id) => this.workers.get(id)?.name ?? id).join(", @")}] ${content}`
        : content;

    const message: Message = {
      id: newId("msg"),
      conversationId,
      author: { type: "worker", workerId: fromWorkerId },
      content: addressed,
      taskId: opts?.taskId,
      createdAt: Date.now(),
    };
    return this.recordMessage(message);
  }

  /**
   * Preferred entry point for desktop `sendMessage`.
   * Records the user message, creates a worker task (or team plan), and lets the
   * dispatcher run the agent loop with streaming.
   */
  async handleUserMessage(input: HandleUserMessageInput): Promise<HandleUserMessageResult> {
    const userMessage: Message = {
      id: newId("msg"),
      conversationId: input.conversationId,
      author: { type: "user" },
      content: input.content,
      createdAt: Date.now(),
    };
    this.recordMessage(userMessage);

    if (this.workersPaused) {
      const sys: Message = {
        id: newId("msg"),
        conversationId: input.conversationId,
        author: { type: "system" },
        content: "Workers are paused. Resume from the tray menu to continue.",
        createdAt: Date.now(),
      };
      this.recordMessage(sys);
      const placeholder = this.createTask({
        id: newId("task"),
        title: "Paused",
        description: input.content,
        status: "cancelled",
        parentId: null,
        dependsOn: [],
        conversationId: input.conversationId,
        taskClass: "simple",
      });
      return { userMessage, task: placeholder, tasks: [placeholder] };
    }

    const conversation = this.database
      ?.listConversations()
      .find((c) => c.id === input.conversationId);

    const teamId = input.teamId ?? conversation?.teamId;
    const team = teamId ? this.teams.get(teamId) : undefined;

    const targetId =
      input.workerId ??
      team?.leadId ??
      conversation?.participantWorkerIds[0] ??
      this.workers.list()[0]?.id;

    // Team with multiple members → plan + delegate
    if (team && team.memberIds.length > 1) {
      const { plan, tasks } = await this.planner.planAndMaterialize({
        goal: input.content,
        team,
        defaultWorkerId: targetId,
        projectId: team.projectId ?? conversation?.projectId,
        conversationId: input.conversationId,
        createdBy: { type: "user" },
      });
      void plan;
      this.dispatcher.kick();
      return { userMessage, task: tasks[0]!, tasks };
    }

    // Single worker (or solo team): one task
    const task = this.createTask({
      id: newId("task"),
      title: truncate(input.content, 80),
      description: input.content,
      status: "pending",
      parentId: null,
      dependsOn: [],
      assignedWorkerId: targetId,
      conversationId: input.conversationId,
      teamId,
      projectId: conversation?.projectId,
      taskClass: "normal",
    });
    this.dispatcher.kick();
    return { userMessage, task, tasks: [task] };
  }

  close(): void {
    this.dispatcher.close();
    this.scheduler.stop();
    this.database?.close();
  }
}

function statusForTool(toolClass: string): Worker["status"] {
  if (toolClass.startsWith("browser")) return "browsing";
  if (toolClass === "input_control" || toolClass === "process") return "controlling_computer";
  if (toolClass === "write" || toolClass === "destructive") return "coding";
  return "working";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
