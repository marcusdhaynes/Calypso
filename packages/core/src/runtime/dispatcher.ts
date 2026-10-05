import type { CoreStreamPush, Task, TaskId, WorkerId } from "@calypso/shared";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { WorkerRuntime } from "./worker-runtime.js";

export interface DispatcherOptions {
  /** Max concurrent tasks across all workers (shared local GPU). Default 2. */
  concurrency?: number;
  /** Poll interval when idle. */
  pollIntervalMs?: number;
  onStream?: (push: CoreStreamPush) => void;
}

/**
 * Non-blocking background dispatcher.
 * - Concurrency-limited across workers
 * - One task per worker at a time
 * - cancel / retry / pause / resume
 * - Parent tasks complete when all children finish (fail if a child fails)
 */
export class TaskDispatcher {
  private running = new Map<TaskId, AbortController>();
  private busyWorkers = new Set<WorkerId>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private paused = false;
  private concurrency: number;
  private pollIntervalMs: number;
  private runtime: WorkerRuntime;
  private onStream?: (push: CoreStreamPush) => void;
  private closed = false;

  constructor(
    private orch: Orchestrator,
    opts: DispatcherOptions = {}
  ) {
    this.concurrency = opts.concurrency ?? 2;
    this.pollIntervalMs = opts.pollIntervalMs ?? 250;
    this.onStream = opts.onStream;
    this.runtime = new WorkerRuntime(orch);
  }

  setStreamHandler(handler: ((push: CoreStreamPush) => void) | undefined): void {
    this.onStream = handler;
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const [, c] of this.running) c.abort();
  }

  close(): void {
    this.closed = true;
    this.stop();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    void this.tick();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Nudge the dispatcher immediately (e.g. after createTask / routine fire). */
  kick(): void {
    void this.tick();
  }

  cancel(taskId: TaskId): Task | undefined {
    const ctrl = this.running.get(taskId);
    ctrl?.abort();
    const t = this.orch.tasks.get(taskId);
    if (!t) return undefined;
    if (t.status === "completed" || t.status === "cancelled") return t;
    // Also cancel pending children
    for (const childId of t.childIds) {
      this.cancel(childId);
    }
    return this.orch.failTaskCancelled(taskId);
  }

  retry(taskId: TaskId): Task | undefined {
    const t = this.orch.tasks.get(taskId);
    if (!t) return undefined;
    if (t.status !== "failed" && t.status !== "cancelled") return t;
    const updated = this.orch.tasks.upsert({
      ...t,
      status: "pending",
      error: undefined,
      result: undefined,
      completedAt: undefined,
      startedAt: undefined,
      retryCount: (t.retryCount ?? 0) + 1,
      updatedAt: Date.now(),
    });
    this.orch.bus.publish({ type: "task.updated", task: updated });
    this.orch.bus.publish({
      type: "task.status",
      taskId,
      status: "pending",
      at: Date.now(),
    });
    this.kick();
    return updated;
  }

  private async tick(): Promise<void> {
    if (this.paused || this.closed) return;

    // Reconcile parent tasks first
    this.reconcileParents();

    while (this.running.size < this.concurrency) {
      const next = this.pickNext();
      if (!next) break;
      void this.launch(next);
    }
  }

  private pickNext(): Task | undefined {
    const ready = this.orch.tasks.readyTasks().filter((t) => {
      if (this.running.has(t.id)) return false;
      // Skip pure container parents that still have children — they wait via "waiting"
      if (t.childIds.length > 0) return false;
      if (!t.assignedWorkerId) return false;
      if (this.busyWorkers.has(t.assignedWorkerId)) return false;
      return true;
    });
    return ready[0];
  }

  private async launch(task: Task): Promise<void> {
    const workerId = task.assignedWorkerId!;
    const ctrl = new AbortController();
    this.running.set(task.id, ctrl);
    this.busyWorkers.add(workerId);

    this.orch.tasks.setStatus(task.id, "running");
    this.orch.bus.publish({
      type: "task.status",
      taskId: task.id,
      status: "running",
      at: Date.now(),
    });

    try {
      const result = await this.runtime.run(task, {
        signal: ctrl.signal,
        conversationId: task.conversationId,
        onStream: this.onStream,
      });

      if (this.closed) return;

      if (result.cancelled || ctrl.signal.aborted) {
        this.orch.failTaskCancelled(task.id);
      } else if (result.ok) {
        this.orch.completeTask(task.id, result.content);
      } else {
        // One automatic retry on transient failure if never retried by dispatcher
        if ((task.retryCount ?? 0) < 1 && result.error && /timeout|temporar|network|ECONN/i.test(result.error)) {
          this.orch.tasks.upsert({
            ...this.orch.tasks.get(task.id)!,
            status: "pending",
            error: result.error,
            retryCount: (task.retryCount ?? 0) + 1,
            updatedAt: Date.now(),
          });
        } else {
          this.orch.failTask(task.id, result.error ?? "Task failed");
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.orch.failTask(task.id, err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.running.delete(task.id);
      this.busyWorkers.delete(workerId);
      if (!this.closed) {
        try {
          this.reconcileParents();
        } catch {
          /* ignore shutdown races */
        }
        queueMicrotask(() => void this.tick());
      }
    }
  }

  private reconcileParents(): void {
    const snap = this.orch.tasks.snapshot();
    for (const id of Object.keys(snap.tasks)) {
      const t = snap.tasks[id]!;
      if (!t.childIds.length) continue;
      if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") continue;

      const children = t.childIds.map((cid) => snap.tasks[cid]).filter(Boolean) as Task[];
      if (!children.length) continue;

      const anyFailed = children.some((c) => c.status === "failed" || c.status === "cancelled");
      const allDone = children.every(
        (c) => c.status === "completed" || c.status === "failed" || c.status === "cancelled"
      );

      if (anyFailed && children.every((c) => c.status !== "running" && c.status !== "pending" && c.status !== "ready" && c.status !== "waiting")) {
        // Prefer failed if any child failed
        const failedChild = children.find((c) => c.status === "failed" || c.status === "cancelled");
        this.orch.failTask(t.id, failedChild?.error ?? "A child task failed");
        continue;
      }

      if (allDone && children.every((c) => c.status === "completed")) {
        const summary = children.map((c) => c.result ?? c.title).join("\n");
        this.orch.completeTask(t.id, summary);
      } else if (t.status === "pending" || t.status === "ready") {
        // Mark container parents as waiting so they don't get picked as leaf work
        this.orch.tasks.setStatus(t.id, "waiting");
      }
    }
  }
}
