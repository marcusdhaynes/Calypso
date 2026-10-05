import type { Tool, ToolResult, WorkerId } from "@calypso/shared";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { newId } from "./ids.js";

/**
 * Built-in coordination tools for workers (toolClass "read" for message,
 * "write" for delegate since it mutates the task graph).
 */
export function createTeamTools(orch: Orchestrator): Tool[] {
  const messageTool: Tool = {
    name: "team.message",
    description:
      "Send a message to one or more teammates. Persists in the shared conversation and publishes bus.chat.",
    toolClass: "read",
    parameters: {
      type: "object",
      properties: {
        toWorkerIds: {
          type: "array",
          items: { type: "string" },
          description: "Recipient worker ids",
        },
        content: { type: "string", description: "Message body" },
        conversationId: { type: "string", description: "Optional conversation to persist into" },
      },
      required: ["toWorkerIds", "content"],
    },
    async execute(params, ctx): Promise<ToolResult> {
      const started = Date.now();
      const toWorkerIds = (params.toWorkerIds as string[]) ?? [];
      const content = String(params.content ?? "");
      const conversationId =
        (params.conversationId as string | undefined) ??
        (ctx.taskId ? orch.tasks.get(ctx.taskId)?.conversationId : undefined);

      const worker = orch.workers.get(ctx.workerId);
      const teamId = worker?.teamId ?? (ctx.taskId ? orch.tasks.get(ctx.taskId)?.teamId : undefined);
      orch.sendWorkerMessage(ctx.workerId, toWorkerIds, content, {
        taskId: ctx.taskId,
        conversationId,
        teamId,
      });

      return {
        toolCallId: ctx.toolCallId,
        ok: true,
        output: { sent: true, toWorkerIds },
        durationMs: Date.now() - started,
      };
    },
  };

  const delegateTool: Tool = {
    name: "team.delegate",
    description:
      "Create a subtask for another team member (appends a child task to the current task graph).",
    toolClass: "write",
    parameters: {
      type: "object",
      properties: {
        workerId: { type: "string", description: "Assignee worker id" },
        title: { type: "string" },
        description: { type: "string" },
        taskClass: {
          type: "string",
          enum: ["simple", "normal", "code", "vision", "reasoning", "frontier"],
        },
      },
      required: ["workerId", "title", "description"],
    },
    async execute(params, ctx): Promise<ToolResult> {
      const started = Date.now();
      const assignee = String(params.workerId ?? "") as WorkerId;
      const title = String(params.title ?? "Delegated task");
      const description = String(params.description ?? "");
      const taskClass = (params.taskClass as "normal") || "normal";
      const parentId = ctx.taskId ?? null;
      const parent = parentId ? orch.tasks.get(parentId) : undefined;

      const child = orch.createTask({
        id: newId("task"),
        title,
        description,
        status: "pending",
        parentId,
        dependsOn: [],
        assignedWorkerId: assignee,
        planId: parent?.planId,
        projectId: parent?.projectId ?? ctx.worker.projectId,
        conversationId: parent?.conversationId,
        teamId: parent?.teamId ?? ctx.worker.teamId,
        taskClass,
      });

      if (parent) {
        orch.tasks.upsert({
          ...parent,
          childIds: [...parent.childIds, child.id],
          status: parent.status === "running" ? "waiting" : parent.status,
          updatedAt: Date.now(),
        });
      }

      orch.dispatcher?.kick();

      return {
        toolCallId: ctx.toolCallId,
        ok: true,
        output: { taskId: child.id, assignedWorkerId: assignee },
        durationMs: Date.now() - started,
      };
    },
  };

  return [messageTool, delegateTool];
}
