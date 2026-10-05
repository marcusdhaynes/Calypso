import type { Task, TaskGraph, TaskId, TaskStatus } from "@calypso/shared";
import type { CalypsoDatabase } from "../db/database.js";

/** Task graph with optional SQLite persistence. */
export class PersistentTaskGraph {
  private tasks = new Map<TaskId, Task>();
  private roots = new Set<TaskId>();

  constructor(private database?: CalypsoDatabase) {
    if (database) {
      for (const t of database.listTasks()) {
        this.tasks.set(t.id, t);
        if (t.parentId === null) this.roots.add(t.id);
      }
    }
  }

  snapshot(): TaskGraph {
    const tasks: Record<TaskId, Task> = {};
    for (const [id, t] of this.tasks) tasks[id] = { ...t };
    return { rootTaskIds: [...this.roots], tasks };
  }

  get(id: TaskId): Task | undefined {
    return this.tasks.get(id);
  }

  upsert(task: Task): Task {
    const full: Task = { ...task, updatedAt: task.updatedAt || Date.now() };
    this.tasks.set(full.id, full);
    if (full.parentId === null) this.roots.add(full.id);
    else this.roots.delete(full.id);
    this.database?.upsertTask(full);
    return full;
  }

  setStatus(id: TaskId, status: TaskStatus): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const updated: Task = { ...t, status, updatedAt: Date.now() };
    if (status === "running" && !updated.startedAt) updated.startedAt = Date.now();
    if (status === "completed" || status === "failed" || status === "cancelled") {
      updated.completedAt = Date.now();
    }
    return this.upsert(updated);
  }

  /** Tasks whose dependencies are all completed and status is pending/ready. */
  readyTasks(): Task[] {
    const out: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== "pending" && t.status !== "ready") continue;
      const depsOk = t.dependsOn.every((d) => this.tasks.get(d)?.status === "completed");
      if (depsOk) out.push(t);
    }
    return out;
  }

  delete(id: TaskId): boolean {
    const ok = this.tasks.delete(id);
    this.roots.delete(id);
    if (ok) this.database?.deleteTask(id);
    return ok;
  }
}

/** @deprecated Alias kept so existing imports keep compiling during the cutover. */
export { PersistentTaskGraph as InMemoryTaskGraph };
