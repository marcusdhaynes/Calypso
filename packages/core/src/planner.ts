import type { PlannedStepDraft, Planner, PlanRequest } from "@calypso/shared";

const STEP_LINE = /^\s*(?:(\d+)[.)]\s+|[-*]\s+)(.*\S)\s*$/;
const ASSIGNEE = /^@([A-Za-z0-9._:-]+)\s+([\s\S]+)$/;

/**
 * Local, deterministic decomposition.
 * Numbered lines and bullets become steps. A goal with no list is one step.
 * An optional `::` suffix sets success criteria. An optional `@role` prefix sets the assignee.
 */
export function decomposeGoal(goal: string): PlannedStepDraft[] {
  const steps: PlannedStepDraft[] = [];
  for (const line of goal.split(/\r?\n/)) {
    const match = STEP_LINE.exec(line);
    const body = match?.[2];
    if (!body) {
      continue;
    }
    const draft = parseStepBody(body);
    if (draft) {
      steps.push(draft);
    }
  }
  if (steps.length > 0) {
    return steps;
  }

  const trimmed = goal.trim();
  if (!trimmed) {
    return [];
  }
  return [singleStep(trimmed)];
}

export const defaultPlanner: Planner = {
  plan(request: PlanRequest): PlannedStepDraft[] {
    return decomposeGoal(request.goal);
  },
};

function parseStepBody(body: string): PlannedStepDraft | null {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }
  const assigneeMatch = ASSIGNEE.exec(trimmed);
  const assignee = assigneeMatch?.[1];
  const remainder = (assigneeMatch?.[2] ?? trimmed).trim();
  const splitAt = remainder.indexOf("::");
  const instruction = (splitAt === -1 ? remainder : remainder.slice(0, splitAt)).trim();
  const criteria = (splitAt === -1 ? "" : remainder.slice(splitAt + 2)).trim();
  if (!instruction) {
    return null;
  }
  return {
    title: instruction,
    instruction,
    successCriteria: criteria || `Completed: ${instruction}`,
    ...(assignee ? { assignee } : {}),
  };
}

function singleStep(goal: string): PlannedStepDraft {
  return {
    title: goal,
    instruction: goal,
    successCriteria: `Completed: ${goal}`,
  };
}
