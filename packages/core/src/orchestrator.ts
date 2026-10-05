import {
  LOCAL_EXECUTION,
  type PlanFailure,
  type PlannedStepDraft,
  type Planner,
  type PlanStep,
  type TeamEvent,
  type TeamPlan,
  type VerifyHook,
} from "@calypso/shared";

import { checkStep } from "./checker.js";
import { delegateStep, type WorkerResolver } from "./dispatcher.js";
import { CloudEscalationDisabledError, errorMessage } from "./errors.js";
import { assertLocalOnly } from "./local.js";
import { defaultPlanner } from "./planner.js";
import { decideRetry, resolveMaxAttempts } from "./retry.js";

export interface RunTeamTaskInput {
  goal: string;
  /** When set, the planner is not called. */
  steps?: readonly PlannedStepDraft[];
  planner?: Planner;
  workers: WorkerResolver;
  /** Explicit host check. Runs after tool outcomes and the worker report. */
  verify?: VerifyHook;
  /** Default attempt budget for steps that do not set their own. Capped. */
  maxAttempts?: number;
  planId?: string;
  signal?: AbortSignal;
  onEvent?: (event: TeamEvent) => void;
}

export type RunTeamTaskResult =
  | { ok: true; plan: TeamPlan; events: TeamEvent[] }
  | { ok: false; plan: TeamPlan; events: TeamEvent[]; failure: PlanFailure };

interface LoopContext {
  plan: TeamPlan;
  workers: WorkerResolver;
  verify?: VerifyHook;
  signal?: AbortSignal;
  emit: (event: TeamEvent) => void;
}

/**
 * Plan a goal into discrete steps, delegate each one, check it, and retry that
 * same step until it checks out or the attempt cap is spent.
 * The next step is not started after a failed check. Nothing here escalates off-box.
 */
export async function runTeamTask(input: RunTeamTaskInput): Promise<RunTeamTaskResult> {
  assertLocalOnly(input);
  const events: TeamEvent[] = [];
  const emit = (event: TeamEvent): void => {
    events.push(event);
    input.onEvent?.(event);
  };

  const planId = input.planId?.trim() || `plan_${crypto.randomUUID()}`;
  const drafted = await loadDrafts(input);
  if (!drafted.ok) {
    return closeWithoutSteps(planId, input.goal, drafted.reason, events, emit);
  }

  const invalid = validateDrafts(drafted.drafts);
  if (invalid) {
    return closeWithoutSteps(planId, input.goal, invalid, events, emit);
  }
  if (drafted.drafts.length === 0) {
    return closeWithoutSteps(planId, input.goal, "Planner produced no steps", events, emit);
  }

  const plan = materializePlan(planId, input.goal, drafted.drafts, input.maxAttempts);
  emit({
    type: "plan.created",
    planId: plan.id,
    goal: plan.goal,
    steps: plan.steps.map((step) => ({
      id: step.id,
      index: step.index,
      title: step.title,
      successCriteria: step.successCriteria,
      ...(step.assignee ? { assignee: step.assignee } : {}),
      maxAttempts: step.maxAttempts,
    })),
  });

  const loop: LoopContext = {
    plan,
    workers: input.workers,
    ...(input.verify ? { verify: input.verify } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    emit,
  };

  try {
    for (const step of plan.steps) {
      if (loop.signal?.aborted) {
        return failClosed(loop, events, {
          reason: "Run aborted",
          attempts: step.attempt,
        });
      }
      const passed = await runStepUntilChecked(loop, step);
      if (!passed) {
        const failure = plan.failure ?? {
          reason: "Step failed",
          attempts: step.attempt,
          stepId: step.id,
        };
        return { ok: false, plan, events, failure };
      }
    }
  } catch (error) {
    if (error instanceof CloudEscalationDisabledError) {
      const current = plan.steps.find(
        (step) => step.status !== "done" && step.status !== "pending",
      );
      plan.status = "failed";
      plan.failure = {
        reason: error.message,
        attempts: current?.attempt ?? 0,
        ...(current ? { stepId: current.id, stepIndex: current.index, title: current.title } : {}),
      };
      if (current && current.attempt > 0) {
        current.status = "failed";
      }
      emit({ type: "plan.failed", planId: plan.id, failure: plan.failure });
      error.plan = plan;
    }
    throw error;
  }

  plan.status = "completed";
  emit({ type: "plan.completed", planId: plan.id });
  return { ok: true, plan, events };
}

async function runStepUntilChecked(loop: LoopContext, step: PlanStep): Promise<boolean> {
  while (true) {
    if (loop.signal?.aborted) {
      return failStep(loop, step, "Run aborted", step.lastCheck);
    }

    step.attempt += 1;
    step.status = "delegated";
    loop.emit({
      type: "step.delegated",
      planId: loop.plan.id,
      stepId: step.id,
      index: step.index,
      attempt: step.attempt,
      maxAttempts: step.maxAttempts,
      ...(step.assignee ? { assignee: step.assignee } : {}),
    });

    const result = await delegateStep(loop.workers, {
      planId: loop.plan.id,
      goal: loop.plan.goal,
      step,
    });
    step.lastResult = result;
    step.status = "checking";
    const check = await checkStep(step, result, loop.verify ? { verify: loop.verify } : {});
    step.lastCheck = check;
    loop.emit({
      type: "step.checked",
      planId: loop.plan.id,
      stepId: step.id,
      attempt: step.attempt,
      check,
    });

    if (check.ok) {
      step.status = "done";
      loop.emit({
        type: "step.done",
        planId: loop.plan.id,
        stepId: step.id,
        attempt: step.attempt,
      });
      return true;
    }

    const decision = decideRetry(step);
    if (decision.action === "retry" && decision.nextAttempt != null) {
      step.status = "retrying";
      loop.emit({
        type: "step.retrying",
        planId: loop.plan.id,
        stepId: step.id,
        attempt: step.attempt,
        nextAttempt: decision.nextAttempt,
        maxAttempts: decision.maxAttempts,
        reason: check.reason,
      });
      continue;
    }

    return failStep(loop, step, check.reason, check);
  }
}

function failStep(
  loop: LoopContext,
  step: PlanStep,
  reason: string,
  lastCheck: PlanStep["lastCheck"],
): false {
  const failure: PlanFailure = {
    stepId: step.id,
    stepIndex: step.index,
    title: step.title,
    reason:
      reason === "Run aborted"
        ? "Run aborted"
        : `Step ${step.index + 1} "${step.title}" failed after ${step.attempt} attempt${step.attempt === 1 ? "" : "s"}: ${reason}`,
    attempts: step.attempt,
    ...(lastCheck ? { lastCheck } : {}),
  };
  if (step.attempt > 0) {
    step.status = "failed";
    loop.emit({
      type: "step.failed",
      planId: loop.plan.id,
      stepId: step.id,
      attempts: step.attempt,
      reason: failure.reason,
    });
  }
  return finishFailed(loop, failure);
}

function finishFailed(loop: LoopContext, failure: PlanFailure): false {
  loop.plan.status = "failed";
  loop.plan.failure = failure;
  loop.emit({ type: "plan.failed", planId: loop.plan.id, failure });
  return false;
}

function failClosed(loop: LoopContext, events: TeamEvent[], failure: PlanFailure): RunTeamTaskResult {
  finishFailed(loop, failure);
  return { ok: false, plan: loop.plan, events, failure };
}

async function loadDrafts(
  input: RunTeamTaskInput,
): Promise<{ ok: true; drafts: readonly PlannedStepDraft[] } | { ok: false; reason: string }> {
  if (input.steps) {
    return { ok: true, drafts: input.steps };
  }
  const planner = input.planner ?? defaultPlanner;
  try {
    const drafts = await planner.plan({ goal: input.goal });
    if (!Array.isArray(drafts)) {
      return { ok: false, reason: "Planner returned no step list" };
    }
    return { ok: true, drafts };
  } catch (error) {
    if (error instanceof CloudEscalationDisabledError) {
      throw error;
    }
    return { ok: false, reason: `Planner failed: ${errorMessage(error)}` };
  }
}

function validateDrafts(drafts: readonly PlannedStepDraft[]): string | null {
  const seen = new Set<string>();
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    if (draft == null || typeof draft !== "object") {
      return `Step ${index + 1} is not an object`;
    }
    assertLocalOnly(draft);
    const problem = draftFieldProblem(draft, index);
    if (problem) {
      return problem;
    }
    const id = draft.id?.trim();
    if (id) {
      if (seen.has(id)) {
        return `Duplicate step id "${id}"`;
      }
      seen.add(id);
    }
  }
  return null;
}

function draftFieldProblem(draft: PlannedStepDraft, index: number): string | null {
  const label = `Step ${index + 1}`;
  for (const field of ["title", "instruction", "successCriteria"] as const) {
    const value = draft[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      return `${label} is missing ${field}`;
    }
  }
  if (draft.assignee != null && (typeof draft.assignee !== "string" || !draft.assignee.trim())) {
    return `${label} has an empty assignee`;
  }
  if (draft.id != null && (typeof draft.id !== "string" || !draft.id.trim())) {
    return `${label} has an empty id`;
  }
  if (
    draft.maxAttempts != null &&
    (typeof draft.maxAttempts !== "number" || !Number.isFinite(draft.maxAttempts))
  ) {
    return `${label} has an invalid maxAttempts`;
  }
  return null;
}

function materializePlan(
  planId: string,
  goal: string,
  drafts: readonly PlannedStepDraft[],
  maxAttempts: number | undefined,
): TeamPlan {
  return {
    id: planId,
    goal,
    execution: LOCAL_EXECUTION,
    status: "running",
    steps: drafts.map((draft, index) => toStep(planId, draft, index, maxAttempts)),
  };
}

function toStep(
  planId: string,
  draft: PlannedStepDraft,
  index: number,
  planMaxAttempts: number | undefined,
): PlanStep {
  const assignee = draft.assignee?.trim();
  return {
    id: draft.id?.trim() || `${planId}:step:${index + 1}`,
    index,
    title: draft.title.trim(),
    instruction: draft.instruction.trim(),
    successCriteria: draft.successCriteria.trim(),
    ...(assignee ? { assignee } : {}),
    status: "pending",
    attempt: 0,
    maxAttempts: resolveMaxAttempts(draft.maxAttempts ?? planMaxAttempts),
    execution: LOCAL_EXECUTION,
  };
}

function closeWithoutSteps(
  planId: string,
  goal: string,
  reason: string,
  events: TeamEvent[],
  emit: (event: TeamEvent) => void,
): RunTeamTaskResult {
  const failure: PlanFailure = { reason, attempts: 0 };
  const plan: TeamPlan = {
    id: planId,
    goal,
    execution: LOCAL_EXECUTION,
    status: "failed",
    steps: [],
    failure,
  };
  emit({ type: "plan.failed", planId, failure });
  return { ok: false, plan, events, failure };
}
