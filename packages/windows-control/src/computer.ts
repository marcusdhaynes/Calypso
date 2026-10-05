import type {
  ActionResult,
  ComputerAction,
  Tool,
  ToolResult,
  WorkerId,
} from "@calypso/shared";
import type { PowerShellHost } from "./host.js";

let actionSeq = 0;

/** Execute a ComputerAction via the PowerShell host (UIA-first). */
export async function runComputerAction(
  host: PowerShellHost,
  action: ComputerAction,
  _workerId: WorkerId
): Promise<ActionResult> {
  const actionId = `ca_${++actionSeq}_${Date.now()}`;
  const started = Date.now();
  const res = await host.request({
    id: actionId,
    method: "action",
    action,
  });
  return {
    actionId,
    ok: res.ok,
    verified: false,
    retries: 0,
    output: res.ok ? res.result : undefined,
    error: res.ok ? undefined : res.error,
    durationMs: Date.now() - started,
  };
}

export function createComputerActionTool(host: PowerShellHost): Tool {
  return {
    name: "windows.computer_action",
    description:
      "Perform a ComputerAction (UIA-element-first, coordinate fallback) via the PowerShell host.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "object", description: "ComputerAction payload" },
      },
      required: ["action"],
    },
    toolClass: "input_control",
    async execute(params, ctx): Promise<ToolResult> {
      const started = Date.now();
      const toolCall = {
        id: ctx.toolCallId,
        toolName: "windows.computer_action",
        toolClass: "input_control" as const,
        params,
        workerId: ctx.workerId,
        taskId: ctx.taskId,
        status: "running" as const,
        createdAt: started,
      };
      const decision = await ctx.gate.check(ctx.worker, toolCall);
      if (decision.decision === "deny") {
        return {
          toolCallId: ctx.toolCallId,
          ok: false,
          error: decision.reason,
          durationMs: Date.now() - started,
        };
      }
      const action = params.action as ComputerAction;
      const result = await runComputerAction(host, action, ctx.workerId);
      return {
        toolCallId: ctx.toolCallId,
        ok: result.ok,
        output: result,
        error: result.error,
        durationMs: Date.now() - started,
      };
    },
  };
}
