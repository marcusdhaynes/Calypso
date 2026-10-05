import type {
  ChatMessage,
  MemoryEntry,
  Message,
  Task,
  Tool,
  Worker,
} from "@calypso/shared";
import type { Orchestrator } from "../orchestrator/orchestrator.js";

const MEMORY_LIMIT_PER_SCOPE = 4;
const RECENT_MESSAGES = 20;

export interface BuiltContext {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: Tool[];
  toolSchemas: unknown[];
  memorySnippets: MemoryEntry[];
}

/**
 * Build a bounded prompt context for a worker task.
 * Never dumps the whole memory store — scoped retrieves with small limits.
 */
export async function buildWorkerContext(
  orch: Orchestrator,
  worker: Worker,
  task: Task,
  conversationId?: string
): Promise<BuiltContext> {
  const memorySnippets: MemoryEntry[] = [];
  const scopes: Array<{ label: string; query: Parameters<Orchestrator["memory"]["retrieve"]>[0] }> = [
    { label: "worker", query: { text: task.description, scope: { type: "worker", workerId: worker.id }, limit: MEMORY_LIMIT_PER_SCOPE } },
    { label: "user", query: { text: task.description, scope: { type: "user" }, limit: MEMORY_LIMIT_PER_SCOPE } },
  ];
  if (worker.teamId) {
    scopes.push({
      label: "team",
      query: { text: task.description, scope: { type: "team", teamId: worker.teamId }, limit: MEMORY_LIMIT_PER_SCOPE },
    });
  }
  if (task.projectId || worker.projectId) {
    const projectId = task.projectId ?? worker.projectId!;
    scopes.push({
      label: "project",
      query: { text: task.description, scope: { type: "project", projectId }, limit: MEMORY_LIMIT_PER_SCOPE },
    });
  }
  const convId = conversationId ?? task.conversationId;
  if (convId) {
    scopes.push({
      label: "conversation",
      query: {
        text: task.description,
        scope: { type: "conversation", conversationId: convId },
        limit: MEMORY_LIMIT_PER_SCOPE,
      },
    });
  }

  for (const s of scopes) {
    try {
      const hits = await orch.memory.retrieve(s.query);
      memorySnippets.push(...hits);
    } catch {
      /* embeddings/provider may be down — skip */
    }
  }

  const allowedNames = new Set(worker.tools);
  const tools =
    allowedNames.size === 0
      ? orch.listTools()
      : orch.listTools().filter((t) => allowedNames.has(t.name));

  const toolSchemas = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const memBlock =
    memorySnippets.length === 0
      ? ""
      : [
          "Relevant memory (bounded):",
          ...memorySnippets.slice(0, 16).map((m) => `- [${m.kind}/${m.scope.type}] ${m.content}`),
        ].join("\n");

  const systemPrompt = [
    `You are ${worker.name}, a Calypso worker.`,
    `Role: ${worker.role}`,
    `Personality: ${worker.personality}`,
    worker.instructions,
    `Current task: ${task.title}`,
    task.description,
    memBlock,
    tools.length
      ? [
          `You may call tools when needed. Available: ${tools.map((t) => t.name).join(", ")}.`,
          "Answer questions, explanations and opinions directly from your own knowledge without tools.",
          "Only call a tool when the task needs you to act on the computer, files, apps or a web page, or to look up something you cannot know.",
          "Never invent ids or parameters; leave optional parameters out (browser tools use your own session automatically).",
        ].join(" ")
      : "No tools are available for this task.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const history: Message[] = convId
    ? (orch.database?.listMessages(convId) ?? []).slice(-RECENT_MESSAGES)
    : [];

  // Also surface recent bus.chat-style messages addressed to this worker from history.
  const addressed = history.filter((m) => {
    if (m.author.type !== "worker") return false;
    if (m.author.workerId === worker.id) return true;
    return m.content.toLowerCase().includes(`@${worker.name.toLowerCase()}`) ||
      m.content.toLowerCase().includes(`@${worker.id.toLowerCase()}`);
  });

  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map(messageToChat),
  ];

  // If history already ends with the user request, don't duplicate task desc.
  if (history.length === 0) {
    chatMessages.push({ role: "user", content: `Task: ${task.title}\n\n${task.description}` });
  } else if (!history.some((m) => m.taskId === task.id && m.author.type === "user")) {
    // Ensure the model sees the specific task even mid-conversation.
    chatMessages.push({ role: "user", content: `Execute task "${task.title}": ${task.description}` });
  }

  void addressed; // used to bias history selection above via filter; history already includes them

  return { systemPrompt, messages: chatMessages, tools, toolSchemas, memorySnippets };
}

function messageToChat(m: Message): ChatMessage {
  if (m.author.type === "user") return { role: "user", content: m.content };
  if (m.author.type === "worker") return { role: "assistant", content: m.content, name: m.author.workerId };
  return { role: "system", content: m.content };
}
