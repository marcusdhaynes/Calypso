import type { ExecutionMode } from "./limits.js";

export type StepStatus =
  | "pending"
  | "delegated"
  | "checking"
  | "retrying"
  | "done"
  | "failed";

export type PlanStatus = "running" | "completed" | "failed";

/** Which signal produced a check verdict. */
export type StepCheckSource =
  | "worker_report"
  | "tool_outcome"
  | "verify_hook"
  | "success_criteria";

export interface ToolOutcome {
  tool: string;
  ok: boolean;
  detail?: string;
  /**
   * Optional host code from a worker package, such as `empty_extract`
   * or `navigate_unverified`. Core treats any `ok: false` as a failed check
   * and does not special-case these codes.
   */
  code?: string;
}

/** What a local worker returns after one attempt at a delegated step. */
export interface StepResult {
  /** Worker-reported success. Tool outcomes and the verify hook can still fail the check. */
  ok: boolean;
  summary: string;
  toolOutcomes?: ToolOutcome[];
  output?: unknown;
  /**
   * Whether the worker claims `successCriteria` were met.
   * Required to pass when the run has no verify hook.
   */
  criteriaMet?: boolean;
}

export interface StepCheckResult {
  ok: boolean;
  source: StepCheckSource;
  reason: string;
}

export interface VerifyHookInput {
  step: PlanStep;
  result: StepResult;
}

/**
 * Host check invoked after tool outcomes are clean.
 * Browser and windows-control adapters can implement this without depending on core.
 */
export interface VerifyHook {
  (input: VerifyHookInput): StepCheckResult | Promise<StepCheckResult>;
}

/** Planner output. Serializable. Functions stay on the run, not on the plan. */
export interface PlannedStepDraft {
  /** Reused when present. The orchestrator generates one otherwise. */
  id?: string;
  title: string;
  instruction: string;
  successCriteria: string;
  /** Local worker role or id. Omitted when a single runtime handles every step. */
  assignee?: string;
  /** Clamped to the shared attempt cap when the plan is materialized. */
  maxAttempts?: number;
}

export interface PlanStep {
  id: string;
  /** Zero-based order. The lead never starts a later step early. */
  index: number;
  title: string;
  instruction: string;
  successCriteria: string;
  assignee?: string;
  status: StepStatus;
  /** Attempts started so far. `0` while the step is still pending. */
  attempt: number;
  maxAttempts: number;
  execution: ExecutionMode;
  lastCheck?: StepCheckResult;
  lastResult?: StepResult;
}

export interface PlanFailure {
  /** Omitted when the plan fails before any step exists. */
  stepId?: string;
  stepIndex?: number;
  title?: string;
  reason: string;
  attempts: number;
  lastCheck?: StepCheckResult;
}

export interface TeamPlan {
  id: string;
  goal: string;
  execution: ExecutionMode;
  status: PlanStatus;
  steps: PlanStep[];
  /** Set when `status` is `failed`. Later steps stay `pending`. */
  failure?: PlanFailure;
}

export interface PlanRequest {
  goal: string;
  hints?: readonly string[];
}

export interface Planner {
  plan(
    request: PlanRequest,
  ): Promise<readonly PlannedStepDraft[]> | readonly PlannedStepDraft[];
}

/** One local handoff from the lead to a worker. */
export interface DispatchRequest {
  planId: string;
  goal: string;
  step: PlanStep;
}
