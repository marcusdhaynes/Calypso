import {
  TEAM_DELEGATE_TOOL,
  TEAM_MESSAGE_TOOL,
  type PlanFailure,
  type PlanStep,
  type TeamDelegateArgs,
  type TeamEvent,
  type TeamMessage,
  type TeamMessageArgs,
  type ToolParameters,
} from "@calypso/shared";

import type { VerifyHook } from "./checker.js";
import type { WorkerResolver } from "./dispatcher.js";
import { assertLocalOnly } from "./local.js";
import { TeamMailbox } from "./mailbox.js";
import { runTeamTask } from "./orchestrator.js";

export interface TeamTool {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute(args: unknown): Promise<unknown>;
}

export interface TeamDelegateToolResult {
  ok: boolean;
  planId: string;
  step?: PlanStep;
  failure?: PlanFailure;
}

export function createTeamMessageTool(mailbox: TeamMailbox = new TeamMailbox()): TeamTool & {
  mailbox: TeamMailbox;
  execute(args: unknown): Promise<TeamMessage>;
} {
  return {
    name: TEAM_MESSAGE_TOOL.name,
    description: TEAM_MESSAGE_TOOL.description,
    parameters: TEAM_MESSAGE_TOOL.parameters,
    mailbox,
    async execute(args: unknown): Promise<TeamMessage> {
      return mailbox.post(parseTeamMessageArgs(args));
    },
  };
}

/**
 * One checked delegation, including bounded retries of that same step.
 * Multi-step continuation belongs to `runTeamTask`.
 */
export function createTeamDelegateTool(options: {
  workers: WorkerResolver;
  verify?: VerifyHook;
  onEvent?: (event: TeamEvent) => void;
}): TeamTool & {
  execute(args: unknown): Promise<TeamDelegateToolResult>;
} {
  return {
    name: TEAM_DELEGATE_TOOL.name,
    description: TEAM_DELEGATE_TOOL.description,
    parameters: TEAM_DELEGATE_TOOL.parameters,
    async execute(args: unknown): Promise<TeamDelegateToolResult> {
      const parsed = parseTeamDelegateArgs(args);
      const result = await runTeamTask({
        goal: parsed.instruction,
        workers: options.workers,
        ...(options.verify ? { verify: options.verify } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        ...(parsed.planId ? { planId: parsed.planId } : {}),
        ...(parsed.maxAttempts != null ? { maxAttempts: parsed.maxAttempts } : {}),
        steps: [
          {
            ...(parsed.stepId ? { id: parsed.stepId } : {}),
            title: parsed.title ?? parsed.instruction,
            instruction: parsed.instruction,
            successCriteria: parsed.successCriteria,
            assignee: parsed.to,
            ...(parsed.maxAttempts != null ? { maxAttempts: parsed.maxAttempts } : {}),
          },
        ],
      });
      const step = result.plan.steps[0];
      return {
        ok: result.ok,
        planId: result.plan.id,
        ...(step ? { step } : {}),
        ...(!result.ok ? { failure: result.failure } : {}),
      };
    },
  };
}

export function parseTeamMessageArgs(args: unknown): TeamMessageArgs {
  const record = objectArgs(args, "team.message");
  return {
    to: requireString(record, "to"),
    body: requireString(record, "body"),
    ...optionalString(record, "from"),
    ...optionalString(record, "planId"),
    ...optionalString(record, "stepId"),
  };
}

export function parseTeamDelegateArgs(args: unknown): TeamDelegateArgs {
  const record = objectArgs(args, "team.delegate");
  const maxAttempts = record.maxAttempts;
  if (maxAttempts != null && (typeof maxAttempts !== "number" || !Number.isFinite(maxAttempts))) {
    throw new TypeError('team.delegate argument "maxAttempts" must be a finite number');
  }
  return {
    to: requireString(record, "to"),
    instruction: requireString(record, "instruction"),
    successCriteria: requireString(record, "successCriteria"),
    ...(typeof record.title === "string" && record.title.trim()
      ? { title: record.title.trim() }
      : {}),
    ...optionalString(record, "planId"),
    ...optionalString(record, "stepId"),
    ...(typeof maxAttempts === "number" ? { maxAttempts } : {}),
  };
}

function objectArgs(args: unknown, tool: string): Record<string, unknown> {
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError(`${tool} arguments must be an object`);
  }
  assertLocalOnly(args);
  return args as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`team tool argument "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  record: Record<string, unknown>,
  key: "from" | "planId" | "stepId",
): Partial<Record<typeof key, string>> {
  const value = record[key];
  if (value == null) {
    return {};
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`team tool argument "${key}" must be a non-empty string`);
  }
  return { [key]: value.trim() };
}
