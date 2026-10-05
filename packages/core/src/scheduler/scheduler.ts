import type { Routine, RoutineId } from "@calypso/shared";

/** Routine scheduler skeleton — cron/interval evaluation TBD (Anky). */
export class RoutineScheduler {
  private routines = new Map<RoutineId, Routine>();

  list(): Routine[] {
    return [...this.routines.values()];
  }

  upsert(routine: Routine): void {
    this.routines.set(routine.id, routine);
  }

  get(id: RoutineId): Routine | undefined {
    return this.routines.get(id);
  }

  /** Due routines whose nextRunAt <= now and enabled. */
  due(now = Date.now()): Routine[] {
    return [...this.routines.values()].filter(
      (r) => r.enabled && r.nextRunAt !== undefined && r.nextRunAt <= now
    );
  }
}
