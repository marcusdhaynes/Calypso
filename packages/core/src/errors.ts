import type { TeamPlan } from "@calypso/shared";

/** Raised when a caller asks the runtime to leave the machine. */
export class CloudEscalationDisabledError extends Error {
  readonly name = "CloudEscalationDisabledError";
  /** Populated when a plan was already materialized before the refusal. */
  plan?: TeamPlan;

  constructor(
    message = "Cloud escalation is disabled. Calypso runs plan steps on the local worker only.",
  ) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Unknown worker error";
}
