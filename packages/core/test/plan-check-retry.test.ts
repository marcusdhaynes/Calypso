import { describe, expect, it } from "vitest";

import {
  CloudEscalationDisabledError,
  createTeamDelegateTool,
  createTeamMessageTool,
  runTeamTask,
  type DispatchRequest,
  type PlannedStepDraft,
  type RunTeamTaskInput,
  type StepResult,
  type TeamEvent,
  type WorkerRuntime,
} from "../src/index.ts";

interface Call {
  stepId: string;
  title: string;
  attempt: number;
  assignee?: string;
}

function pass(summary: string): StepResult {
  return {
    ok: true,
    summary,
    criteriaMet: true,
    toolOutcomes: [{ tool: "local.worker", ok: true }],
  };
}

function fail(summary: string, extra: Partial<StepResult> = {}): StepResult {
  return {
    ok: false,
    summary,
    criteriaMet: false,
    ...extra,
  };
}

function scripted(scripts: Record<string, StepResult[]>): WorkerRuntime & { calls: Call[] } {
  const cursors = new Map<string, number>();
  const calls: Call[] = [];
  return {
    calls,
    async execute(request: DispatchRequest): Promise<StepResult> {
      calls.push({
        stepId: request.step.id,
        title: request.step.title,
        attempt: request.step.attempt,
        ...(request.step.assignee ? { assignee: request.step.assignee } : {}),
      });
      const script = scripts[request.step.title] ?? [];
      const index = cursors.get(request.step.title) ?? 0;
      cursors.set(request.step.title, index + 1);
      return (
        script[index] ?? {
          ok: false,
          summary: `unexpected attempt ${index + 1} for ${request.step.title}`,
          criteriaMet: false,
        }
      );
    },
  };
}

const threeSteps: PlannedStepDraft[] = [
  { title: "Open", instruction: "Open the doc", successCriteria: "Doc is open" },
  { title: "Edit", instruction: "Edit the line", successCriteria: "Line is updated" },
  { title: "Save", instruction: "Save the doc", successCriteria: "Doc is saved" },
];

describe("runTeamTask", () => {
  it("checks each step before starting the next", async () => {
    const workers = scripted({
      Open: [pass("opened")],
      Edit: [pass("edited")],
      Save: [pass("saved")],
    });
    const seen: TeamEvent[] = [];

    const result = await runTeamTask({
      goal: "Update the doc",
      planId: "plan_happy",
      workers,
      steps: threeSteps,
      onEvent: (event) => seen.push(event),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.status).toBe("completed");
    expect(result.plan.execution).toBe("local");
    expect(result.plan.steps.map((step) => [step.status, step.attempt])).toEqual([
      ["done", 1],
      ["done", 1],
      ["done", 1],
    ]);
    expect(workers.calls.map((call) => [call.title, call.attempt, call.stepId])).toEqual([
      ["Open", 1, "plan_happy:step:1"],
      ["Edit", 1, "plan_happy:step:2"],
      ["Save", 1, "plan_happy:step:3"],
    ]);
    expect(seen.map((event) => event.type)).toEqual([
      "plan.created",
      "step.delegated",
      "step.checked",
      "step.done",
      "step.delegated",
      "step.checked",
      "step.done",
      "step.delegated",
      "step.checked",
      "step.done",
      "plan.completed",
    ]);
    expect(seen).toHaveLength(result.events.length);
  });

  it("retries the same step after a failed check, then continues", async () => {
    const workers = scripted({
      Open: [pass("opened")],
      Edit: [
        {
          ok: true,
          summary: "extract came back empty",
          criteriaMet: true,
          toolOutcomes: [
            {
              tool: "browser.extract",
              ok: false,
              code: "empty_extract",
              detail: "no text",
            },
          ],
        },
        pass("edited"),
      ],
      Save: [pass("saved")],
    });

    const result = await runTeamTask({
      goal: "Update the doc",
      planId: "plan_retry",
      workers,
      steps: threeSteps,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const edit = result.plan.steps[1];
    expect(edit?.status).toBe("done");
    expect(edit?.attempt).toBe(2);
    expect(edit?.lastCheck).toMatchObject({ ok: true, source: "success_criteria" });
    const retry = result.events.find((event) => event.type === "step.retrying");
    expect(retry).toMatchObject({
      type: "step.retrying",
      stepId: "plan_retry:step:2",
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
    });
    expect(retry && retry.type === "step.retrying" ? retry.reason : "").toContain("empty_extract");
    expect(workers.calls.map((call) => call.title)).toEqual(["Open", "Edit", "Edit", "Save"]);
    expect(workers.calls.filter((call) => call.title === "Edit").map((call) => call.stepId)).toEqual([
      "plan_retry:step:2",
      "plan_retry:step:2",
    ]);
  });

  it("fails the plan upward when retries are exhausted and does not start the next step", async () => {
    const workers = scripted({
      Open: [pass("opened")],
      Edit: [fail("still stale"), fail("still stale"), fail("still stale")],
      Save: [pass("saved")],
    });

    const result = await runTeamTask({
      goal: "Update the doc",
      planId: "plan_closed",
      workers,
      steps: threeSteps,
      maxAttempts: 9,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.plan.status).toBe("failed");
    expect(result.failure.stepId).toBe("plan_closed:step:2");
    expect(result.failure.attempts).toBe(3);
    expect(result.failure.reason).toContain('Step 2 "Edit" failed after 3 attempts');
    expect(result.failure.reason).toContain("still stale");
    expect(result.plan.steps[1]).toMatchObject({ status: "failed", attempt: 3, maxAttempts: 3 });
    expect(result.plan.steps[2]).toMatchObject({ status: "pending", attempt: 0 });
    expect(workers.calls.map((call) => call.title)).toEqual(["Open", "Edit", "Edit", "Edit"]);
    expect(result.events.map((event) => event.type)).toContain("step.failed");
    expect(result.events.map((event) => event.type)).toContain("plan.failed");
    expect(result.events.map((event) => event.type)).not.toContain("plan.completed");
    expect(result.events.some((event) => event.type === "step.delegated" && event.stepId.endsWith(":3"))).toBe(
      false,
    );
  });

  it("does not retry when the step budget is one", async () => {
    const workers = scripted({
      Open: [fail("nope")],
      Save: [pass("saved")],
    });
    const result = await runTeamTask({
      goal: "Two steps",
      planId: "plan_once",
      workers,
      maxAttempts: 1,
      steps: [
        { title: "Open", instruction: "Open", successCriteria: "Open" },
        { title: "Save", instruction: "Save", successCriteria: "Saved" },
      ],
    });

    expect(result.ok).toBe(false);
    expect(workers.calls.map((call) => call.title)).toEqual(["Open"]);
    expect(result.events.some((event) => event.type === "step.retrying")).toBe(false);
  });

  it("treats a thrown worker error as a failed attempt that can still succeed", async () => {
    let attempt = 0;
    const workers: WorkerRuntime = {
      async execute() {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("socket reset");
        }
        return pass("recovered");
      },
    };

    const result = await runTeamTask({
      goal: "Reconnect",
      planId: "plan_throw",
      workers,
      steps: [{ title: "Reconnect", instruction: "Reconnect", successCriteria: "Connected" }],
    });

    expect(result.ok).toBe(true);
    expect(result.plan.steps[0]).toMatchObject({ status: "done", attempt: 2 });
    expect(result.events.find((event) => event.type === "step.checked" && !event.check.ok)).toMatchObject({
      check: { source: "worker_report", reason: "socket reset" },
    });
  });

  it("uses the verify hook and retries that hook until it passes", async () => {
    let checks = 0;
    const workers = scripted({
      Look: [pass("first"), pass("second")],
    });
    const result = await runTeamTask({
      goal: "Look",
      planId: "plan_hook",
      workers,
      steps: [{ title: "Look", instruction: "Look", successCriteria: "Host confirms the window" }],
      verify: ({ result: workerResult }) => {
        checks += 1;
        if (checks === 1) {
          return { ok: false, source: "verify_hook", reason: "window title mismatch" };
        }
        expect(workerResult.summary).toBe("second");
        return { ok: true, source: "verify_hook", reason: "window title matches" };
      },
    });

    expect(result.ok).toBe(true);
    expect(checks).toBe(2);
    expect(result.plan.steps[0]?.lastCheck).toMatchObject({
      ok: true,
      source: "verify_hook",
      reason: "window title matches",
    });
  });

  it("fails a blank plan upward without delegating", async () => {
    const workers = scripted({});
    const result = await runTeamTask({
      goal: "   ",
      planId: "plan_empty",
      workers,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.failure.reason).toBe("Planner produced no steps");
    expect(result.plan.steps).toEqual([]);
    expect(workers.calls).toEqual([]);
    expect(result.events.map((event) => event.type)).toEqual(["plan.failed"]);
  });

  it("refuses cloud escalation before any worker runs", async () => {
    const workers = scripted({ Work: [pass("nope")] });
    const input = {
      goal: "Ship it",
      workers,
      escalate: "cloud",
      steps: [{ title: "Work", instruction: "Work", successCriteria: "Done" }],
    } as RunTeamTaskInput;

    await expect(runTeamTask(input)).rejects.toBeInstanceOf(CloudEscalationDisabledError);
    expect(workers.calls).toEqual([]);
  });

  it("stops the plan when a worker result asks to leave the machine", async () => {
    const calls: string[] = [];
    const workers: WorkerRuntime = {
      async execute(request) {
        calls.push(request.step.title);
        if (request.step.title === "Open") {
          return { ok: true, summary: "cloud", criteriaMet: true, execution: "cloud" } as StepResult;
        }
        return pass("saved");
      },
    };

    const error = await runTeamTask({
      goal: "Update the doc",
      planId: "plan_cloud_result",
      workers,
      steps: threeSteps,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CloudEscalationDisabledError);
    const cloudError = error as CloudEscalationDisabledError;
    expect(cloudError.plan?.status).toBe("failed");
    expect(cloudError.plan?.steps[1]?.status).toBe("pending");
    expect(cloudError.plan?.steps[2]?.status).toBe("pending");
    expect(calls).toEqual(["Open"]);
  });

  it("aborts between steps without starting the rest", async () => {
    const workers = scripted({
      Open: [pass("opened")],
      Save: [pass("saved")],
    });
    const controller = new AbortController();
    controller.abort();

    const result = await runTeamTask({
      goal: "Update",
      planId: "plan_abort",
      workers,
      signal: controller.signal,
      steps: [
        { title: "Open", instruction: "Open", successCriteria: "Open" },
        { title: "Save", instruction: "Save", successCriteria: "Saved" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.failure.reason).toBe("Run aborted");
    expect(result.plan.steps.every((step) => step.status === "pending")).toBe(true);
    expect(workers.calls).toEqual([]);
  });
});

describe("team tools", () => {
  it("delegates one checked step with a bounded retry and keeps messages local", async () => {
    let attempt = 0;
    const delegate = createTeamDelegateTool({
      workers: {
        async execute() {
          attempt += 1;
          if (attempt < 2) {
            return fail("not yet");
          }
          return pass("done");
        },
      },
    });
    const mailbox = createTeamMessageTool();

    const delegated = await delegate.execute({
      to: "worker.local",
      instruction: "Count the rows",
      successCriteria: "Row count is recorded",
      planId: "plan_tool",
      stepId: "step_rows",
      escalate: "local",
    });
    const message = await mailbox.execute({
      to: "lead",
      from: "worker.local",
      body: "Row count is 4",
      planId: "plan_tool",
      stepId: "step_rows",
    });

    expect(delegated.ok).toBe(true);
    expect(delegated.step).toMatchObject({ id: "step_rows", status: "done", attempt: 2, assignee: "worker.local" });
    expect(delegated.planId).toBe("plan_tool");
    expect(attempt).toBe(2);
    expect(mailbox.mailbox.list({ planId: "plan_tool" })).toEqual([message]);
  });

  it("returns a failed check upward from team.delegate when the cap is spent", async () => {
    const delegate = createTeamDelegateTool({
      workers: {
        async execute() {
          return fail("blocked");
        },
      },
    });

    const delegated = await delegate.execute({
      to: "worker.local",
      title: "Click save",
      instruction: "Click save",
      successCriteria: "Saved",
      maxAttempts: 2,
    });

    expect(delegated.ok).toBe(false);
    expect(delegated.failure?.attempts).toBe(2);
    expect(delegated.step?.status).toBe("failed");
  });

  it("rejects a cloud mode passed to a team tool", async () => {
    const delegate = createTeamDelegateTool({
      workers: {
        async execute() {
          return pass("should not run");
        },
      },
    });

    await expect(
      delegate.execute({
        to: "worker.local",
        instruction: "Leave the machine",
        successCriteria: "Never",
        execution: "cloud",
      }),
    ).rejects.toBeInstanceOf(CloudEscalationDisabledError);
  });
});
