import type {
  EmbeddingProvider,
  Message,
  ModelRouter,
  Plan,
  Task,
  TaskId,
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
import type { MemoryStore } from "@calypso/shared";

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
}

/**
 * Top-level orchestration façade.
 * Intended to run inside an Electron utilityProcess (see apps/desktop).
 *
 * Persistence: better-sqlite3 via CalypsoDatabase when a path is provided.
 * Memory retrieve uses Angen's createLocalEmbeddingProvider when available.
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
  readonly gate: DefaultPermissionGate;
  readonly modelRouter: ModelRouter | undefined;
  readonly embeddings: EmbeddingProvider | undefined;

  private tools = new Map<string, Tool>();
  private running = new Set<TaskId>();

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
    this.memory = this.database
      ? new SqliteMemoryStore(this.database, this.embeddings)
      : new InMemoryMemoryStore();
    this.gate = new DefaultPermissionGate(this.bus);

    this.scheduler.start((routine) => {
      const task = this.createTask({
        id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: routine.taskTemplate.title,
        description: routine.taskTemplate.description,
        status: "pending",
        parentId: null,
        dependsOn: [],
        assignedWorkerId: routine.workerId,
        projectId: routine.projectId,
        taskClass: routine.taskTemplate.taskClass,
      });
      this.bus.publish({
        type: "routine.fired",
        routineId: routine.id,
        taskId: task.id,
        at: Date.now(),
      });
    });
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
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
    partial: Omit<Task, "childIds" | "createdAt" | "updatedAt"> & { childIds?: TaskId[] }
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
    return saved;
  }

  /**
   * Expand an approved Plan into the task graph (parent root + step children).
   */
  materializePlan(plan: Plan, assignedWorkerId?: WorkerId): Task[] {
    const root = this.createTask({
      id: `task_plan_${plan.id}`,
      title: plan.title,
      description: plan.goal,
      status: "pending",
      parentId: null,
      dependsOn: [],
      assignedWorkerId,
      planId: plan.id,
      projectId: plan.projectId,
      taskClass: "reasoning",
    });

    const stepTasks: Task[] = [];
    const stepIdToTaskId = new Map<string, TaskId>();

    for (const step of plan.steps) {
      const id = `task_step_${plan.id}_${step.id}`;
      stepIdToTaskId.set(step.id, id);
      const dependsOn = step.dependsOnStepIds
        .map((sid) => stepIdToTaskId.get(sid))
        .filter((x): x is TaskId => !!x);
      const child = this.createTask({
        id,
        title: step.title,
        description: step.description,
        status: "pending",
        parentId: root.id,
        dependsOn: dependsOn.length ? dependsOn : [root.id],
        assignedWorkerId,
        planId: plan.id,
        projectId: plan.projectId,
        taskClass: step.taskClass,
      });
      stepTasks.push(child);
    }

    this.tasks.upsert({
      ...root,
      childIds: stepTasks.map((t) => t.id),
      updatedAt: Date.now(),
    });

    this.bus.publish({ type: "plan.updated", plan: { ...plan, status: "executing" } });
    return [root, ...stepTasks];
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
    try {
      const result = await tool.execute(toolCall.params, {
        toolCallId: toolCall.id,
        workerId: worker.id,
        worker,
        taskId: toolCall.taskId,
        gate: this.gate,
        onProgress: (progress) => this.bus.publish({ type: "tool.progress", progress }),
      });

      let finalResult: ToolResult = {
        ...result,
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
      return finalResult;
    } finally {
      this.workers.setStatus(worker.id, "idle");
    }
  }

  /**
   * Drain ready tasks (dependency-satisfied) for background processing.
   * Does not freeze the UI — each task runs independently; caller may await.
   */
  async pump(max = 8): Promise<Task[]> {
    const ready = this.tasks.readyTasks().filter((t) => !this.running.has(t.id)).slice(0, max);
    for (const t of ready) {
      this.running.add(t.id);
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
    this.running.delete(id);
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
    this.running.delete(id);
    const updated = this.tasks.upsert({
      ...t,
      status: "failed",
      error,
      updatedAt: Date.now(),
      completedAt: Date.now(),
    });
    this.bus.publish({ type: "task.updated", task: updated });
    return updated;
  }

  recordMessage(message: Message): Message {
    this.database?.upsertMessage(message);
    this.bus.publish({ type: "message.created", message });
    return message;
  }

  close(): void {
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
