import type { Task, TaskGraph, TaskId, TaskStatus } from "@calypso/shared";

/** In-memory task graph skeleton. Persistence lands in SQLite (Anky). */
export class InMemoryTaskGraph {
  private tasks = new Map<TaskId, Task>();
  private roots = new Set<TaskId>();

  snapshot(): TaskGraph {
    const tasks: Record<TaskId, Task> = {};
    for (const [id, t] of this.tasks) tasks[id] = { ...t };
    return { rootTaskIds: [...this.roots], tasks };
  }

  get(id: TaskId): Task | undefined {
    return this.tasks.get(id);
  }

  upsert(task: Task): void {
    this.tasks.set(task.id, task);
    if (task.parentId === null) this.roots.add(task.id);
    else this.roots.delete(task.id);
  }

  setStatus(id: TaskId, status: TaskStatus): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const updated: Task = { ...t, status, updatedAt: Date.now() };
    if (status === "running" && !updated.startedAt) updated.startedAt = Date.now();
    if (status === "completed" || status === "failed" || status === "cancelled") {
      updated.completedAt = Date.now();
    }
    this.tasks.set(id, updated);
    return updated;
  }

  /** Tasks whose dependencies are all completed and status is pending. */
  readyTasks(): Task[] {
    const out: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== "pending" && t.status !== "ready") continue;
      const depsOk = t.dependsOn.every((d) => this.tasks.get(d)?.status === "completed");
      if (depsOk) out.push(t);
    }
    return out;
  }
}
