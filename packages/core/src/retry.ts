import { DEFAULT_MAX_ATTEMPTS, MAX_ATTEMPTS_CAP, type PlanStep } from "@calypso/shared";

export interface RetryDecision {
  action: "retry" | "fail";
  attemptsUsed: number;
  maxAttempts: number;
  /** Set when `action` is `retry`. */
  nextAttempt?: number;
}

/** Clamp a requested budget into `[1, MAX_ATTEMPTS_CAP]`. */
export function resolveMaxAttempts(requested?: number): number {
  if (requested == null || !Number.isFinite(requested)) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  const attempts = Math.floor(requested);
  if (attempts < 1) {
    return 1;
  }
  if (attempts > MAX_ATTEMPTS_CAP) {
    return MAX_ATTEMPTS_CAP;
  }
  return attempts;
}

/**
 * A failed check retries the same step while attempts remain.
 * The caller must not advance to the next step when the action is `fail`.
 */
export function decideRetry(step: Pick<PlanStep, "attempt" | "maxAttempts">): RetryDecision {
  const maxAttempts = resolveMaxAttempts(step.maxAttempts);
  if (step.attempt < maxAttempts) {
    return {
      action: "retry",
      attemptsUsed: step.attempt,
      maxAttempts,
      nextAttempt: step.attempt + 1,
    };
  }
  return {
    action: "fail",
    attemptsUsed: step.attempt,
    maxAttempts,
  };
}
