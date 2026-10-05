import { describe, expect, it } from "vitest";

import { decomposeGoal, runTeamTask, type WorkerRuntime } from "../src/index.ts";

describe("decomposeGoal", () => {
  it("turns numbered lines and bullets into steps with criteria and assignees", () => {
    const steps = decomposeGoal(
      ["Context to ignore", "1. Open the file", "- @editor Replace the title :: Title reads Calypso"].join(
        "\n",
      ),
    );

    expect(steps).toEqual([
      {
        title: "Open the file",
        instruction: "Open the file",
        successCriteria: "Completed: Open the file",
      },
      {
        title: "Replace the title",
        instruction: "Replace the title",
        successCriteria: "Title reads Calypso",
        assignee: "editor",
      },
    ]);
  });

  it("uses the whole goal when it is a single instruction", () => {
    expect(decomposeGoal("Summarize the notes")).toEqual([
      {
        title: "Summarize the notes",
        instruction: "Summarize the notes",
        successCriteria: "Completed: Summarize the notes",
      },
    ]);
  });

  it("returns no steps for a blank goal", () => {
    expect(decomposeGoal("  \n\t")).toEqual([]);
  });
});

describe("default planner", () => {
  it("runs a multi-line goal as discrete steps and skips the planner when steps are supplied", async () => {
    const calls: string[] = [];
    const workers: WorkerRuntime = {
      async execute(request) {
        calls.push(request.step.title);
        return { ok: true, summary: request.step.title, criteriaMet: true };
      },
    };
    let plannerCalls = 0;

    const planned = await runTeamTask({
      goal: "1. Read\n2. Write",
      planId: "plan_lines",
      workers,
    });
    const supplied = await runTeamTask({
      goal: "1. Read\n2. Write",
      planId: "plan_supplied",
      workers,
      steps: [
        {
          title: "Only this",
          instruction: "Only this",
          successCriteria: "It ran",
        },
      ],
      planner: {
        plan() {
          plannerCalls += 1;
          return [];
        },
      },
    });

    expect(planned.ok).toBe(true);
    expect(calls.slice(0, 2)).toEqual(["Read", "Write"]);
    expect(planned.plan.steps.map((step) => step.successCriteria)).toEqual([
      "Completed: Read",
      "Completed: Write",
    ]);
    expect(supplied.ok).toBe(true);
    expect(supplied.plan.steps).toHaveLength(1);
    expect(plannerCalls).toBe(0);
  });
});
