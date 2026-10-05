import type { Tool, ToolResult } from "@calypso/shared";

export const codeExecTool: Tool = {
  name: "code.exec",
  description: "Evaluate a short code snippet in a sandboxed interpreter.",
  parameters: {
    type: "object",
    properties: {
      language: { type: "string", enum: ["javascript", "typescript", "python"] },
      source: { type: "string" },
    },
    required: ["language", "source"],
  },
  toolClass: "process",
  async execute(params, ctx): Promise<ToolResult> {
    const started = Date.now();
    const decision = await ctx.gate.check(ctx.worker, {
      id: ctx.toolCallId,
      toolName: "code.exec",
      toolClass: "process",
      params,
      workerId: ctx.workerId,
      taskId: ctx.taskId,
      status: "running",
      createdAt: started,
    });
    if (decision.decision === "deny") {
      return {
        toolCallId: ctx.toolCallId,
        ok: false,
        error: decision.reason,
        durationMs: Date.now() - started,
      };
    }
    return {
      toolCallId: ctx.toolCallId,
      ok: false,
      error: `code.exec stub — language=${String(params.language)}`,
      durationMs: Date.now() - started,
    };
  },
};
