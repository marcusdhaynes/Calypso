import { describe, expect, it } from "vitest";

import { checkStep, type PlanStep, type StepResult } from "../src/index.ts";

function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "step_1",
    index: 0,
    title: "Extract the headline",
    instruction: "Extract the headline",
    successCriteria: "Headline text is present",
    status: "checking",
    attempt: 1,
    maxAttempts: 3,
    execution: "local",
    ...overrides,
  };
}

function result(overrides: Partial<StepResult> = {}): StepResult {
  return {
    ok: true,
    summary: "done",
    criteriaMet: true,
    ...overrides,
  };
}

describe("checkStep", () => {
  it("fails closed when the worker omits a result", async () => {
    const check = await checkStep(step(), undefined);
    expect(check).toMatchObject({ ok: false, source: "worker_report" });
  });

  it("lets a failed tool outcome override a worker success claim", async () => {
    const check = await checkStep(
      step(),
      result({
        toolOutcomes: [
          { tool: "browser.extract", ok: false, code: "empty_extract", detail: "no text" },
        ],
      }),
    );
    expect(check.ok).toBe(false);
    expect(check.source).toBe("tool_outcome");
    expect(check.reason).toContain("browser.extract");
    expect(check.reason).toContain("empty_extract");
  });

  it("fails when the worker reports failure", async () => {
    const check = await checkStep(step(), result({ ok: false, summary: "dialog still open" }));
    expect(check).toMatchObject({
      ok: false,
      source: "worker_report",
      reason: "dialog still open",
    });
  });

  it("requires criteriaMet when no verify hook is registered", async () => {
    const check = await checkStep(step(), result({ criteriaMet: false }));
    expect(check.ok).toBe(false);
    expect(check.source).toBe("success_criteria");
    expect(check.reason).toContain("Headline text is present");
  });

  it("accepts a passing verify hook in place of criteriaMet", async () => {
    const check = await checkStep(step(), result({ criteriaMet: undefined }), {
      verify: () => ({ ok: true, source: "verify_hook", reason: "headline visible" }),
    });
    expect(check).toEqual({ ok: true, source: "verify_hook", reason: "headline visible" });
  });

  it("records a thrown verify hook as a failed check", async () => {
    const check = await checkStep(step(), result(), {
      verify: () => {
        throw new Error("host probe missed");
      },
    });
    expect(check).toEqual({ ok: false, source: "verify_hook", reason: "host probe missed" });
  });

  it("passes on success criteria when tools and the worker report are clean", async () => {
    const check = await checkStep(step(), result());
    expect(check).toEqual({ ok: true, source: "success_criteria", reason: "Success criteria met" });
  });
});
