import { CloudEscalationDisabledError } from "./errors.js";

const ESCALATION_KEYS = ["execution", "escalate", "escalation", "mode"] as const;

/**
 * Reject any payload that asks for a non-local execution mode.
 * Absent mode fields are local. There is no cloud branch to take.
 */
export function assertLocalOnly(value: unknown): void {
  if (value == null || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ESCALATION_KEYS) {
    if (!(key in record)) {
      continue;
    }
    const mode = record[key];
    if (mode != null && mode !== "local") {
      throw new CloudEscalationDisabledError();
    }
  }
}
