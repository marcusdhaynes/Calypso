import type {
  PlanStep,
  StepCheckResult,
  StepResult,
  ToolOutcome,
  VerifyHook,
} from "@calypso/shared";

import { errorMessage } from "./errors.js";

export type { VerifyHook, VerifyHookInput } from "@calypso/shared";

export interface CheckContext {
  verify?: VerifyHook;
}

/**
 * Decide whether a finished attempt is good enough to leave behind.
 *
 * Order:
 * 1. Missing result → fail (`worker_report`).
 * 2. Any tool outcome with `ok: false` → fail (`tool_outcome`). Tool evidence wins over the worker's claim.
 * 3. `result.ok !== true` → fail (`worker_report`).
 * 4. Blank success criteria → fail (`success_criteria`).
 * 5. Verify hook, when the run registered one → its verdict (`verify_hook`).
 * 6. Otherwise `criteriaMet` must be `true` (`success_criteria`).
 */
export async function checkStep(
  step: PlanStep,
  result: StepResult | undefined,
  context: CheckContext = {},
): Promise<StepCheckResult> {
  if (!result) {
    return {
      ok: false,
      source: "worker_report",
      reason: "Worker returned no result",
    };
  }

  const failedTools = (result.toolOutcomes ?? []).filter((outcome) => !outcome.ok);
  if (failedTools.length > 0) {
    return {
      ok: false,
      source: "tool_outcome",
      reason: describeToolFailures(failedTools),
    };
  }

  if (result.ok !== true) {
    const summary = result.summary.trim();
    return {
      ok: false,
      source: "worker_report",
      reason: summary || "Worker reported failure",
    };
  }

  if (step.successCriteria.trim().length === 0) {
    return {
      ok: false,
      source: "success_criteria",
      reason: "Step is missing success criteria",
    };
  }

  if (context.verify) {
    try {
      const verdict = await context.verify({ step, result });
      if (verdict.ok === true) {
        return {
          ok: true,
          source: "verify_hook",
          reason: verdict.reason.trim() || "Verify hook passed",
        };
      }
      return {
        ok: false,
        source: "verify_hook",
        reason: verdict.reason.trim() || "Verify hook failed",
      };
    } catch (error) {
      return {
        ok: false,
        source: "verify_hook",
        reason: errorMessage(error),
      };
    }
  }

  if (result.criteriaMet === true) {
    return {
      ok: true,
      source: "success_criteria",
      reason: "Success criteria met",
    };
  }

  return {
    ok: false,
    source: "success_criteria",
    reason: `Success criteria not met: ${step.successCriteria}`,
  };
}

function describeToolFailures(failed: ToolOutcome[]): string {
  const first = failed[0];
  if (!first) {
    return "Tool reported failure";
  }
  const code = first.code ? ` [${first.code}]` : "";
  const detail = first.detail?.trim() || "tool reported failure";
  const extra = failed.length > 1 ? ` (+${failed.length - 1} more)` : "";
  const name = first.tool.trim() || "tool";
  return `${name} failed${code}: ${detail}${extra}`;
}
