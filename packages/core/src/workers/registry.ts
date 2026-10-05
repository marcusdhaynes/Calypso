import type { Worker, WorkerId, WorkerStatus } from "@calypso/shared";
import type { CalypsoDatabase } from "../db/database.js";

/** Persistent worker registry — loads from and syncs to SQLite when a DB is provided. */
export class WorkerRegistry {
  private workers = new Map<WorkerId, Worker>();

  constructor(private database?: CalypsoDatabase) {
    if (database) {
      for (const w of database.listWorkers()) this.workers.set(w.id, w);
    }
  }

  list(): Worker[] {
    return [...this.workers.values()];
  }

  get(id: WorkerId): Worker | undefined {
    return this.workers.get(id);
  }

  upsert(worker: Worker): Worker {
    const now = Date.now();
    const full: Worker = { ...worker, updatedAt: worker.updatedAt || now };
    this.workers.set(full.id, full);
    this.database?.upsertWorker(full);
    return full;
  }

  setStatus(id: WorkerId, status: WorkerStatus): Worker | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    return this.upsert({ ...w, status, updatedAt: Date.now() });
  }

  delete(id: WorkerId): boolean {
    const ok = this.workers.delete(id);
    if (ok) this.database?.deleteWorker(id);
    return ok;
  }
}
