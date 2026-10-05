import type { Routine, RoutineId } from "@calypso/shared";
import type { CalypsoDatabase } from "../db/database.js";

/** Routine scheduler with optional SQLite persistence. */
export class RoutineScheduler {
  private routines = new Map<RoutineId, Routine>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private onFire: ((routine: Routine) => void) | undefined;

  constructor(private database?: CalypsoDatabase) {
    if (database) {
      for (const r of database.listRoutines()) this.routines.set(r.id, r);
    }
  }

  list(): Routine[] {
    return [...this.routines.values()];
  }

  upsert(routine: Routine): Routine {
    const full: Routine = { ...routine, updatedAt: routine.updatedAt || Date.now() };
    this.routines.set(full.id, full);
    this.database?.upsertRoutine(full);
    return full;
  }

  get(id: RoutineId): Routine | undefined {
    return this.routines.get(id);
  }

  delete(id: RoutineId): boolean {
    const ok = this.routines.delete(id);
    if (ok) this.database?.deleteRoutine(id);
    return ok;
  }

  /** Due routines whose nextRunAt <= now and enabled. */
  due(now = Date.now()): Routine[] {
    return [...this.routines.values()].filter(
      (r) => r.enabled && r.nextRunAt !== undefined && r.nextRunAt <= now
    );
  }

  /**
   * Start a lightweight poll loop (default 15s). Caller supplies onFire to
   * enqueue work onto the task graph — keeps the scheduler free of orchestrator cycles.
   */
  start(onFire: (routine: Routine) => void, intervalMs = 15_000): void {
    this.onFire = onFire;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), intervalMs);
    // Don't keep the process alive solely for the scheduler in tests.
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(now = Date.now()): Routine[] {
    const fired: Routine[] = [];
    for (const routine of this.due(now)) {
      const next = this.computeNextRun(routine, now);
      const updated = this.upsert({
        ...routine,
        lastRunAt: now,
        nextRunAt: next,
        updatedAt: now,
      });
      fired.push(updated);
      this.onFire?.(updated);
    }
    return fired;
  }

  private computeNextRun(routine: Routine, from: number): number | undefined {
    const s = routine.schedule;
    if (s.type === "once") return undefined;
    if (s.type === "interval") return from + s.ms;
    // Minimal cron: support "m h * * *" only (minute hour). Falls back to +1h.
    const parts = s.expression.trim().split(/\s+/);
    if (parts.length >= 2) {
      const minute = Number(parts[0]);
      const hour = Number(parts[1]);
      if (!Number.isNaN(minute) && !Number.isNaN(hour) && parts[0] !== "*" && parts[1] !== "*") {
        const d = new Date(from);
        d.setSeconds(0, 0);
        d.setMinutes(minute);
        d.setHours(hour);
        if (d.getTime() <= from) d.setDate(d.getDate() + 1);
        return d.getTime();
      }
    }
    return from + 60 * 60 * 1000;
  }
}
