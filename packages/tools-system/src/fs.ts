import type { Tool, ToolResult } from "@calypso/shared";

async function gated(
  ctx: Parameters<Tool["execute"]>[1],
  toolName: string,
  toolClass: Tool["toolClass"],
  params: Record<string, unknown>
): Promise<ToolResult | null> {
  const started = Date.now();
  const decision = await ctx.gate.check(ctx.worker, {
    id: ctx.toolCallId,
    toolName,
    toolClass,
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
  return null;
}

export const fsReadTool: Tool = {
  name: "fs.read",
  description: "Read a UTF-8 text file from the worker workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or workspace-relative path" },
    },
    required: ["path"],
  },
  toolClass: "read",
  async execute(params, ctx): Promise<ToolResult> {
    const denied = await gated(ctx, "fs.read", "read", params);
    if (denied) return denied;
    const started = Date.now();
    return {
      toolCallId: ctx.toolCallId,
      ok: false,
      error: `fs.read stub — path=${String(params.path)}`,
      durationMs: Date.now() - started,
    };
  },
};

export const fsWriteTool: Tool = {
  name: "fs.write",
  description: "Write a UTF-8 text file inside the worker workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  toolClass: "write",
  async execute(params, ctx): Promise<ToolResult> {
    const denied = await gated(ctx, "fs.write", "write", params);
    if (denied) return denied;
    const started = Date.now();
    return {
      toolCallId: ctx.toolCallId,
      ok: false,
      error: `fs.write stub — path=${String(params.path)}`,
      durationMs: Date.now() - started,
    };
  },
};
