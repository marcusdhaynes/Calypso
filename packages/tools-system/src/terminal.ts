import type { Tool, ToolResult } from "@calypso/shared";

export const terminalExecTool: Tool = {
  name: "terminal.exec",
  description: "Run a shell command in the worker workspace.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["command"],
  },
  toolClass: "process",
  async execute(params, ctx): Promise<ToolResult> {
    const started = Date.now();
    const decision = await ctx.gate.check(ctx.worker, {
      id: ctx.toolCallId,
      toolName: "terminal.exec",
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
    ctx.onProgress({
      toolCallId: ctx.toolCallId,
      message: `Would exec: ${String(params.command)}`,
    });
    return {
      toolCallId: ctx.toolCallId,
      ok: false,
      error: "terminal.exec stub",
      durationMs: Date.now() - started,
    };
  },
};
