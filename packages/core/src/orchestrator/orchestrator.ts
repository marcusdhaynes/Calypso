import type { ModelRouter, Task, TaskId } from "@calypso/shared";
import { InProcessEventBus } from "../bus/event-bus.js";
import { InMemoryTaskGraph } from "../task-graph/task-graph.js";
import { WorkerRegistry } from "../workers/registry.js";
import { TeamRegistry } from "../teams/teams.js";
import { InMemoryMemoryStore } from "../memory/memory-store.js";
import { RoutineScheduler } from "../scheduler/scheduler.js";
import { DefaultPermissionGate } from "../permissions/gate.js";

export interface OrchestratorOptions {
  modelRouter?: ModelRouter;
}

/**
 * Top-level orchestration façade.
 * Intended to run inside an Electron utilityProcess (see apps/desktop).
 */
export class Orchestrator {
  readonly bus = new InProcessEventBus();
  readonly tasks = new InMemoryTaskGraph();
  readonly workers = new WorkerRegistry();
  readonly teams = new TeamRegistry();
  readonly memory = new InMemoryMemoryStore();
  readonly scheduler = new RoutineScheduler();
  readonly gate: DefaultPermissionGate;
  readonly modelRouter: ModelRouter | undefined;

  constructor(opts: OrchestratorOptions = {}) {
    this.modelRouter = opts.modelRouter;
    this.gate = new DefaultPermissionGate(this.bus);
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
    this.tasks.upsert(task);
    this.bus.publish({ type: "task.created", task });
    return task;
  }
}
