import type { ToolParameters } from "./json.js";

export interface TeamMessage {
  id: string;
  to: string;
  from?: string;
  body: string;
  planId?: string;
  stepId?: string;
  createdAt: string;
}

export interface TeamMessageArgs {
  to: string;
  body: string;
  from?: string;
  planId?: string;
  stepId?: string;
}

export interface TeamDelegateArgs {
  to: string;
  instruction: string;
  successCriteria: string;
  title?: string;
  planId?: string;
  stepId?: string;
  /** Clamped by the shared attempt cap. */
  maxAttempts?: number;
}

export const TEAM_MESSAGE_TOOL = {
  name: "team.message",
  description:
    "Send a local message to another teammate. Messages stay in the in-process mailbox and are never uploaded.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["to", "body"],
    properties: {
      to: { type: "string", description: "Local teammate id or role." },
      body: { type: "string", description: "Message text." },
      from: { type: "string", description: "Sender id. Optional." },
      planId: { type: "string", description: "Plan this note belongs to." },
      stepId: { type: "string", description: "Step this note belongs to." },
    },
  },
} as const satisfies {
  name: "team.message";
  description: string;
  parameters: ToolParameters;
};

export const TEAM_DELEGATE_TOOL = {
  name: "team.delegate",
  description:
    "Delegate one step to a local worker. The runtime checks the result and retries the same step up to the attempt cap, then returns a failure. It does not start later steps and it does not escalate off-box.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["to", "instruction", "successCriteria"],
    properties: {
      to: { type: "string", description: "Local worker id or role." },
      instruction: { type: "string", description: "What the worker should do." },
      successCriteria: {
        type: "string",
        description: "Bar the checker requires before the step can pass.",
      },
      title: { type: "string", description: "Short step label. Defaults to the instruction." },
      planId: { type: "string", description: "Existing plan id, if this step is part of one." },
      stepId: { type: "string", description: "Existing step id to reuse for this attempt." },
      maxAttempts: {
        type: "integer",
        description: "Requested attempt budget. The runtime clamps this to the shared cap.",
      },
    },
  },
} as const satisfies {
  name: "team.delegate";
  description: string;
  parameters: ToolParameters;
};
