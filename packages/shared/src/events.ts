import type { PlanFailure, StepCheckResult } from "./plan.js";

export interface PlanCreatedEvent {
  type: "plan.created";
  planId: string;
  goal: string;
  steps: ReadonlyArray<{
    id: string;
    index: number;
    title: string;
    successCriteria: string;
    assignee?: string;
    maxAttempts: number;
  }>;
}

export interface StepDelegatedEvent {
  type: "step.delegated";
  planId: string;
  stepId: string;
  index: number;
  attempt: number;
  maxAttempts: number;
  assignee?: string;
}

export interface StepCheckedEvent {
  type: "step.checked";
  planId: string;
  stepId: string;
  attempt: number;
  check: StepCheckResult;
}

export interface StepRetryingEvent {
  type: "step.retrying";
  planId: string;
  stepId: string;
  /** Attempt that just failed the check. */
  attempt: number;
  nextAttempt: number;
  maxAttempts: number;
  reason: string;
}

export interface StepDoneEvent {
  type: "step.done";
  planId: string;
  stepId: string;
  attempt: number;
}

export interface StepFailedEvent {
  type: "step.failed";
  planId: string;
  stepId: string;
  attempts: number;
  reason: string;
}

export interface PlanCompletedEvent {
  type: "plan.completed";
  planId: string;
}

export interface PlanFailedEvent {
  type: "plan.failed";
  planId: string;
  failure: PlanFailure;
}

export type TeamEvent =
  | PlanCreatedEvent
  | StepDelegatedEvent
  | StepCheckedEvent
  | StepRetryingEvent
  | StepDoneEvent
  | StepFailedEvent
  | PlanCompletedEvent
  | PlanFailedEvent;
