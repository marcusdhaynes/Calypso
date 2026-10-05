import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatMessage,
  ChatToolCall,
  CoreStreamPush,
  Message,
  Task,
  ToolCall,
  Worker,
  WorkerStatus,
} from "@calypso/shared";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { buildCompletionRequest } from "@calypso/models";
import { buildWorkerContext } from "./context.js";
import { newId } from "./ids.js";

export interface WorkerRuntimeOptions {
  maxIterations?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  conversationId?: string;
  onStream?: (push: CoreStreamPush) => void;
}

export interface WorkerRuntimeResult {
  ok: boolean;
  content: string;
  toolCallIds: string[];
  error?: string;
  cancelled?: boolean;
}

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_TIMEOUT_MS = 120_000;

function isTransientModelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|ECONNRESET|ECONNREFUSED|503|502|429|temporar|network|fetch failed/i.test(msg);
}

function publishStatus(orch: Orchestrator, workerId: string, status: WorkerStatus): void {
  try {
    orch.workers.setStatus(workerId, status);
    orch.bus.publish({ type: "worker.status", workerId, status, at: Date.now() });
  } catch {
    /* DB may already be closed during shutdown/cancel races */
  }
}

/**
 * Agent loop for a single task: Plan → Execute → Observe → Verify.
 * Streams tokens via onStream (CoreStreamPush) for the desktop UI.
 */
export class WorkerRuntime {
  constructor(private orch: Orchestrator) {}

  async run(
    task: Task,
    opts: WorkerRuntimeOptions = {}
  ): Promise<WorkerRuntimeResult> {
    const workerId = task.assignedWorkerId;
    if (!workerId) {
      return { ok: false, content: "", toolCallIds: [], error: "Task has no assigned worker" };
    }
    const worker = this.orch.workers.get(workerId);
    if (!worker) {
      return { ok: false, content: "", toolCallIds: [], error: `Unknown worker ${workerId}` };
    }
    if (!this.orch.modelRouter) {
      return { ok: false, content: "", toolCallIds: [], error: "No ModelRouter configured" };
    }

    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const conversationId = opts.conversationId ?? task.conversationId;
    const toolCallIds: string[] = [];

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const messageId = newId("msg");
    let fullContent = "";

    try {
      publishStatus(this.orch, worker.id, "thinking");

      const ctx = await buildWorkerContext(this.orch, worker, task, conversationId);
      const messages: ChatMessage[] = [...ctx.messages];

      const { provider, model } = await this.orch.modelRouter.resolve(
        task.taskClass,
        worker.preferredModel
      );

      let attempt = 0;
      for (let iter = 0; iter < maxIterations; iter++) {
        if (controller.signal.aborted) {
          return { ok: false, content: fullContent, toolCallIds, error: "Cancelled", cancelled: true };
        }

        publishStatus(this.orch, worker.id, iter === 0 ? "thinking" : "working");

        const request = buildCompletionRequest(
          {
            model,
            messages,
            temperature: 0.4,
            stream: true,
            tools: ctx.toolSchemas.length ? ctx.toolSchemas : undefined,
          },
          task.taskClass
        );

        let assistantText = "";
        const pendingToolCalls = new Map<number, ChatToolCall>();

        const runStream = async () => {
          for await (const chunk of provider.stream(request, controller.signal)) {
            if (controller.signal.aborted) break;
            collectChunk(chunk, pendingToolCalls, (delta) => {
              assistantText += delta;
              fullContent += delta;
              if (conversationId && opts.onStream) {
                opts.onStream({
                  channel: "stream",
                  conversationId,
                  messageId,
                  delta,
                  done: false,
                  workerId: worker.id,
                });
              }
            });
          }
        };

        try {
          await runStream();
        } catch (err) {
          if (controller.signal.aborted) {
            return { ok: false, content: fullContent, toolCallIds, error: "Cancelled", cancelled: true };
          }
          if (attempt === 0 && isTransientModelError(err)) {
            attempt += 1;
            iter -= 1; // retry this iteration once
            continue;
          }
          throw err;
        }

        const toolCalls = [...pendingToolCalls.values()].filter((t) => t.function?.name);

        if (toolCalls.length === 0) {
          // Final textual answer
          if (conversationId) {
            const message: Message = {
              id: messageId,
              conversationId,
              author: { type: "worker", workerId: worker.id },
              content: assistantText || fullContent || "(empty reply)",
              taskId: task.id,
              toolCallIds: toolCallIds.length ? toolCallIds : undefined,
              createdAt: Date.now(),
            };
            try { this.orch.recordMessage(message); } catch { /* shutdown */ }
            opts.onStream?.({
              channel: "stream",
              conversationId,
              messageId,
              delta: "",
              done: true,
              workerId: worker.id,
            });
          }

          await this.writeEpisode(worker, task, assistantText || fullContent);
          return { ok: true, content: assistantText || fullContent, toolCallIds };
        }

        // Observe: append assistant tool_calls turn, execute each tool, append tool results
        messages.push({
          role: "assistant",
          content: assistantText || "",
          tool_calls: toolCalls,
        });

        for (const tc of toolCalls) {
          if (controller.signal.aborted) {
            return { ok: false, content: fullContent, toolCallIds, error: "Cancelled", cancelled: true };
          }
          const tool = this.orch.getTool(tc.function.name);
          const toolCall: ToolCall = {
            id: tc.id || newId("tc"),
            toolName: tc.function.name,
            toolClass: tool?.toolClass ?? "read",
            params: parseArgs(tc.function.arguments),
            workerId: worker.id,
            taskId: task.id,
            status: "pending",
            createdAt: Date.now(),
          };
          toolCallIds.push(toolCall.id);

          const result = await this.orch.executeToolCall(worker, toolCall);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result.ok
              ? JSON.stringify(result.output ?? { ok: true })
              : JSON.stringify({ ok: false, error: result.error }),
          });
        }
        // Loop: Verify implicitly by feeding tool results back to the model
      }

      const err = `Exceeded max iterations (${maxIterations})`;
      if (conversationId) {
        this.orch.recordMessage({
          id: messageId,
          conversationId,
          author: { type: "worker", workerId: worker.id },
          content: fullContent || err,
          taskId: task.id,
          toolCallIds: toolCallIds.length ? toolCallIds : undefined,
          createdAt: Date.now(),
        });
        opts.onStream?.({
          channel: "stream",
          conversationId,
          messageId,
          delta: "",
          done: true,
          workerId: worker.id,
        });
      }
      return { ok: false, content: fullContent, toolCallIds, error: err };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (conversationId) {
        this.orch.recordMessage({
          id: messageId,
          conversationId,
          author: { type: "system" },
          content: `Model error: ${error}`,
          taskId: task.id,
          createdAt: Date.now(),
        });
        opts.onStream?.({
          channel: "stream",
          conversationId,
          messageId,
          delta: `Model error: ${error}`,
          done: true,
          workerId: worker.id,
        });
      }
      return { ok: false, content: fullContent, toolCallIds, error };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      publishStatus(this.orch, worker.id, "idle");
    }
  }

  private async writeEpisode(worker: Worker, task: Task, content: string): Promise<void> {
    const summary = content.slice(0, 500) || task.title;
    try {
      await this.orch.memory.write({
        kind: "episode",
        content: `Completed "${task.title}": ${summary}`,
        scope: { type: "worker", workerId: worker.id },
        metadata: { taskId: task.id },
      });
      if (task.conversationId) {
        await this.orch.memory.write({
          kind: "summary",
          content: summary,
          scope: { type: "conversation", conversationId: task.conversationId },
          metadata: { taskId: task.id, workerId: worker.id },
        });
      }
    } catch {
      /* memory optional */
    }
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { value: v };
  } catch {
    return { raw };
  }
}

function collectChunk(
  chunk: ChatCompletionChunk,
  pending: Map<number, ChatToolCall>,
  onText: (delta: string) => void
): void {
  const choice = chunk.choices?.[0];
  if (!choice) return;
  const delta = choice.delta;
  if (typeof delta.content === "string" && delta.content) {
    onText(delta.content);
  }
  const tcs = delta.tool_calls;
  if (!Array.isArray(tcs)) return;
  for (const raw of tcs) {
    const tc = raw as {
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    };
    const index = tc.index ?? 0;
    let cur = pending.get(index);
    if (!cur) {
      cur = {
        id: tc.id || newId("tc"),
        type: "function",
        function: { name: "", arguments: "" },
        index,
      };
      pending.set(index, cur);
    }
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.function.name += tc.function.name;
    if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
  }
}
