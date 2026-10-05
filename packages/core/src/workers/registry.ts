import type { Worker, WorkerId, WorkerStatus } from "@calypso/shared";

/** Worker registry skeleton — SQLite persistence TBD (Anky). */
export class WorkerRegistry {
  private workers = new Map<WorkerId, Worker>();

  list(): Worker[] {
    return [...this.workers.values()];
  }

  get(id: WorkerId): Worker | undefined {
    return this.workers.get(id);
  }

  upsert(worker: Worker): void {
    this.workers.set(worker.id, worker);
  }

  setStatus(id: WorkerId, status: WorkerStatus): Worker | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    const updated = { ...w, status, updatedAt: Date.now() };
    this.workers.set(id, updated);
    return updated;
  }
}
