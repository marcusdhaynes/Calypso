import { LOCAL_EXECUTION, type DispatchRequest, type StepResult } from "@calypso/shared";

import { CloudEscalationDisabledError, errorMessage } from "./errors.js";
import { assertLocalOnly } from "./local.js";

/** Local worker. Implementations must not call a cloud agent runtime. */
export interface WorkerRuntime {
  execute(request: DispatchRequest): Promise<StepResult>;
}

export interface WorkerRegistry {
  get(assignee?: string): WorkerRuntime;
}

export type WorkerResolver = WorkerRuntime | WorkerRegistry;

export function isWorkerRegistry(resolver: WorkerResolver): resolver is WorkerRegistry {
  return typeof (resolver as WorkerRegistry).get === "function" && !("execute" in resolver);
}

export function resolveWorker(resolver: WorkerResolver, assignee?: string): WorkerRuntime {
  if (!isWorkerRegistry(resolver)) {
    return resolver;
  }
  return resolver.get(assignee);
}

/** One local delegation. Retry policy lives in the orchestrator, not here. */
export async function delegateStep(
  workers: WorkerResolver,
  request: DispatchRequest,
): Promise<StepResult> {
  assertLocalOnly(request);
  assertLocalOnly(request.step);
  if (request.step.execution !== LOCAL_EXECUTION) {
    throw new CloudEscalationDisabledError();
  }

  try {
    const worker = resolveWorker(workers, request.step.assignee);
    const result = await worker.execute(request);
    assertLocalOnly(result);
    return result;
  } catch (error) {
    if (error instanceof CloudEscalationDisabledError) {
      throw error;
    }
    return {
      ok: false,
      summary: errorMessage(error),
      criteriaMet: false,
    };
  }
}
