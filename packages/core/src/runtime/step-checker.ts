import type { Task } from "@calypso/shared";
import { buildCompletionRequest } from "@calypso/models";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { WorkerRuntimeResult } from "./worker-runtime.js";

/** Plan -> check -> retry: total attempts per plan step (first try + 2 retries). */
export const MAX_STEP_ATTEMPTS = 3;

export interface StepCheck {
  ok: boolean;
  reason: string;
}

/**
 * Decide whether a finished plan step actually met its goal (ported from Anky's
 * checkStep, local only). Order:
 *  1. no result text            -> fail
 *  2. last tool call failed      -> fail (earlier failures the worker recovered from are fine)
 *  3. worker says it failed      -> fail
 *  4. no success criteria        -> pass
 *  5. local model judges the result against the criteria; an unreadable verdict passes
 */
export async function checkStep(
  orch: Orchestrator,
  task: Task,
  result: WorkerRuntimeResult
): Promise<StepCheck> {
  const content = (result.content ?? "").trim();
  if (!content) return { ok: false, reason: "The worker returned no result." };

  const outcomes = result.toolOutcomes ?? [];
  const last = outcomes[outcomes.length - 1];
  if (last && !last.ok) {
    return { ok: false, reason: `Last tool call ${last.toolName} failed: ${last.error ?? "unknown error"}` };
  }

  if (/^\s*(i (could not|couldn't|was unable to|am unable to)|unable to|failed to)\b/i.test(content)) {
    return { ok: false, reason: `The worker reported it could not finish: ${truncate(content, 200)}` };
  }

  const criteria = task.successCriteria?.trim();
  if (!criteria) return { ok: true, reason: "No success criteria; accepted." };
  if (!orch.modelRouter) return { ok: true, reason: "No model available to check; accepted." };

  try {
    const { provider, model } = await orch.modelRouter.resolve("normal");
    const request = buildCompletionRequest(
      {
        model,
        messages: [
          {
            role: "system",
            content:
              'You check whether a task step was completed. Reply with ONLY JSON: {"ok":true|false,"reason":"one short sentence"}.',
          },
          {
            role: "user",
            content: [
              `Step: ${task.title}`,
              `Success criteria: ${criteria}`,
              `Tools used: ${outcomes.map((o) => `${o.toolName}(${o.ok ? "ok" : "failed"})`).join(", ") || "none"}`,
              `Worker result:\n${truncate(content, 3000)}`,
              "Does the result meet the success criteria?",
            ].join("\n\n"),
          },
        ],
        temperature: 0,
        stream: false,
      },
      "normal"
    );
    const resp = await provider.complete(request);
    const raw = resp.choices?.[0]?.message?.content;
    return parseVerdict(typeof raw === "string" ? raw : "");
  } catch {
    return { ok: true, reason: "Checker unavailable; accepted." };
  }
}

export function parseVerdict(raw: string): StepCheck {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const v = JSON.parse(m[0]) as { ok?: unknown; reason?: unknown };
      if (typeof v.ok === "boolean") {
        return { ok: v.ok, reason: typeof v.reason === "string" && v.reason ? v.reason : v.ok ? "Criteria met." : "Criteria not met." };
      }
    } catch {
      /* fall through */
    }
  }
  return { ok: true, reason: "Checker verdict unreadable; accepted." };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
