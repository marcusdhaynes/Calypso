/**
 * @calypso/shared — Cross-package contracts
 *
 * RULE: Subsystems must talk ONLY through these interfaces.
 * Do not import implementation details across package boundaries.
 *
 * Ownership:
 *   core / workers / memory     → Anky
 *   windows-control             → Trice
 *   browser                     → Spin
 *   models                      → Angen
 *   ui / voice / packaging / QA → Theriz
 *   integration                 → Tyran
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type WorkerId = string;
export type TeamId = string;
export type ConversationId = string;
export type MessageId = string;
export type TaskId = string;
export type PlanId = string;
export type ToolCallId = string;
export type RoutineId = string;
export type MemoryId = string;
export type ProjectId = string;
export type ArtifactId = string;
export type BrowserSessionId = string;
export type ControlSessionId = string;
export type ActionId = string;
export type TerminalSessionId = string;
export type ScreenshotRef = string;

// ---------------------------------------------------------------------------
// Autonomy & permissions
// ---------------------------------------------------------------------------

/**
 * How freely a worker may act without asking the user.
 * - observe: read-only; everything else denied
 * - ask:     ask on destructive / credential / process-kill; allow milder writes
 * - trusted: ask only on destructive; allow process/network/browser
 * - full:    allow everything except credential *reveal*, which still asks
 */
export type AutonomyLevel = "observe" | "ask" | "trusted" | "full";

/** Per-call decision from the PermissionGate. */
export type ToolPermission = "allow" | "ask" | "deny";

/**
 * Coarse class of side-effect a tool can cause.
 * Used by the default policy table (autonomy × tool class → allow/ask/deny).
 */
export type ToolClass =
  | "read"
  | "write"
  | "destructive"
  | "process"
  | "network"
  | "credential"
  | "browser_download"
  | "browser_upload"
  | "browser_offorigin_nav"
  | "input_control";

/**
 * Default policy: AutonomyLevel × ToolClass → ToolPermission.
 *
 * observe: read only
 * ask:     destructive / credential / process → ask; read/write/network/browser_* allow-or-ask as below
 * trusted: destructive → ask; credential → ask; else allow
 * full:    allow everything except credential → ask
 */
export const DEFAULT_PERMISSION_POLICY: Record<
  AutonomyLevel,
  Record<ToolClass, ToolPermission>
> = {
  observe: {
    read: "allow",
    write: "deny",
    destructive: "deny",
    process: "deny",
    network: "deny",
    credential: "deny",
    browser_download: "deny",
    browser_upload: "deny",
    browser_offorigin_nav: "deny",
    input_control: "deny",
  },
  ask: {
    read: "allow",
    write: "ask",
    destructive: "ask",
    process: "ask",
    network: "ask",
    credential: "ask",
    browser_download: "ask",
    browser_upload: "ask",
    browser_offorigin_nav: "ask",
    input_control: "ask",
  },
  trusted: {
    read: "allow",
    write: "allow",
    destructive: "ask",
    process: "allow",
    network: "allow",
    credential: "ask",
    browser_download: "allow",
    browser_upload: "allow",
    browser_offorigin_nav: "allow",
    input_control: "allow",
  },
  full: {
    read: "allow",
    write: "allow",
    destructive: "allow",
    process: "allow",
    network: "allow",
    credential: "ask", // credential reveal always asks, even at full
    browser_download: "allow",
    browser_upload: "allow",
    browser_offorigin_nav: "allow",
    input_control: "allow",
  },
};

export type PermissionDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | {
      decision: "ask";
      /** Correlation id; UI responds via permission.resolved event / IPC. */
      requestId: string;
      reason: string;
      toolCall: ToolCall;
      workerId: WorkerId;
    };

/**
 * Gate every Tool.execute must call before performing side effects.
 * Implementations live in core; UI answers "ask" via the event bus.
 */
export interface PermissionGate {
  check(worker: Worker, toolCall: ToolCall): Promise<PermissionDecision>;
  /** Resolve a pending ask from the UI. */
  resolve(requestId: string, allow: boolean): void;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export type WorkerStatus =
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "controlling_computer"
  | "browsing"
  | "coding"
  | "speaking"
  | "error"
  | "offline";

/**
 * A worker is an autonomous agent with a role, personality, tool access,
 * and a preferred model class. Persisted in SQLite by core.
 */
export interface Worker {
  id: WorkerId;
  name: string;
  avatar: string;
  role: string;
  personality: string;
  instructions: string;
  skills: string[];
  /** Tool names this worker is allowed to invoke. */
  tools: string[];
  /** Fine-grained permission grants (tool or resource scoped). */
  permissions: string[];
  preferredModel: TaskClass | string;
  voice?: string;
  workspace: string;
  autonomyLevel: AutonomyLevel;
  status: WorkerStatus;
  teamId?: TeamId;
  projectId?: ProjectId;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Team / Project / Artifact
// ---------------------------------------------------------------------------

export interface Team {
  id: TeamId;
  name: string;
  description: string;
  memberIds: WorkerId[];
  leadId?: WorkerId;
  projectId?: ProjectId;
  createdAt: number;
  updatedAt: number;
}

/**
 * A Project groups conversations, workers, teams, files, memory, goals,
 * tasks, terminal sessions, and browser state into one workspace unit.
 */
export interface Project {
  id: ProjectId;
  name: string;
  description: string;
  goals: string[];
  conversationIds: ConversationId[];
  workerIds: WorkerId[];
  teamIds: TeamId[];
  taskIds: TaskId[];
  artifactIds: ArtifactId[];
  terminalSessionIds: TerminalSessionId[];
  browserSessionIds: BrowserSessionId[];
  /** Root folder on disk for project files. */
  filesRoot: string;
  createdAt: number;
  updatedAt: number;
}

export type ArtifactKind =
  | "code"
  | "document"
  | "image"
  | "table"
  | "chart"
  | "file"
  | "plan"
  | "website";

export interface Artifact {
  id: ArtifactId;
  kind: ArtifactKind;
  title: string;
  /** Path, URL, or inline reference depending on kind. */
  uri: string;
  mimeType?: string;
  projectId?: ProjectId;
  taskId?: TaskId;
  createdBy: MessageAuthor;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Conversation & Message
// ---------------------------------------------------------------------------

export type MessageAuthor =
  | { type: "user" }
  | { type: "worker"; workerId: WorkerId }
  | { type: "system" };

export interface Conversation {
  id: ConversationId;
  title: string;
  participantWorkerIds: WorkerId[];
  teamId?: TeamId;
  projectId?: ProjectId;
  taskId?: TaskId;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: MessageId;
  conversationId: ConversationId;
  author: MessageAuthor;
  content: string;
  taskId?: TaskId;
  toolCallIds?: ToolCallId[];
  artifactIds?: ArtifactId[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Task graph
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: TaskId;
  title: string;
  description: string;
  status: TaskStatus;
  parentId: TaskId | null;
  childIds: TaskId[];
  dependsOn: TaskId[];
  assignedWorkerId?: WorkerId;
  planId?: PlanId;
  projectId?: ProjectId;
  taskClass: TaskClass;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TaskGraph {
  rootTaskIds: TaskId[];
  tasks: Record<TaskId, Task>;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface Plan {
  id: PlanId;
  title: string;
  goal: string;
  steps: PlanStep[];
  status: "draft" | "approved" | "executing" | "completed" | "failed" | "cancelled";
  createdBy: MessageAuthor;
  projectId?: ProjectId;
  createdAt: number;
  updatedAt: number;
}

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  taskClass: TaskClass;
  dependsOnStepIds: string[];
  taskId?: TaskId;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * @deprecated Prefer ToolClass + PermissionGate. Kept for migration notes.
 */
export type ToolPermissionLevel =
  | "read"
  | "write"
  | "execute"
  | "system"
  | "network";

export interface ToolProgress {
  toolCallId: ToolCallId;
  message: string;
  percent?: number;
  data?: unknown;
}

/**
 * A callable capability. Every Tool declares its ToolClass and MUST call
 * PermissionGate.check before performing side effects.
 */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema describing the params object. */
  parameters: Record<string, unknown>;
  /** Side-effect class used by the default policy table. */
  toolClass: ToolClass;
  execute: (
    params: Record<string, unknown>,
    ctx: ToolExecutionContext
  ) => Promise<ToolResult>;
}

export interface ToolExecutionContext {
  toolCallId: ToolCallId;
  workerId: WorkerId;
  worker: Worker;
  taskId?: TaskId;
  gate: PermissionGate;
  onProgress: (progress: ToolProgress) => void;
  signal?: AbortSignal;
}

export interface ToolCall {
  id: ToolCallId;
  toolName: string;
  toolClass: ToolClass;
  params: Record<string, unknown>;
  workerId: WorkerId;
  taskId?: TaskId;
  status: "pending" | "running" | "awaiting_permission" | "completed" | "failed" | "cancelled";
  createdAt: number;
}

export interface ToolResult {
  toolCallId: ToolCallId;
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Browser (Spin) — Playwright, persistent context per worker
// ---------------------------------------------------------------------------

export interface BrowserSession {
  id: BrowserSessionId;
  workerId: WorkerId;
  projectId?: ProjectId;
  /** Active tab id within the persistent Playwright context. */
  activeTabId: string;
  tabs: BrowserTab[];
  /** Origin allow-list; offrigin nav requires browser_offorigin_nav permission. */
  allowedOrigins: string[];
  createdAt: number;
  updatedAt: number;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

/**
 * DOM / accessibility-locator-first targeting.
 * Prefer role+name / testId / css over raw coordinates.
 */
export type DomLocator =
  | { kind: "role"; role: string; name?: string }
  | { kind: "label"; label: string }
  | { kind: "text"; text: string }
  | { kind: "css"; selector: string }
  | { kind: "testId"; testId: string }
  | { kind: "xpath"; xpath: string };

export type BrowserAction =
  | { type: "navigate"; url: string }
  | { type: "click"; locator: DomLocator }
  | { type: "type"; locator: DomLocator; text: string; clear?: boolean }
  | { type: "scroll"; locator?: DomLocator; deltaX?: number; deltaY?: number }
  | { type: "select"; locator: DomLocator; values: string[] }
  | { type: "upload"; locator: DomLocator; files: string[] }
  | { type: "download"; locator: DomLocator; saveAs?: string }
  | { type: "extract"; locator?: DomLocator; prompt?: string }
  | { type: "newTab"; url?: string }
  | { type: "switchTab"; tabId: string }
  | { type: "closeTab"; tabId: string }
  | { type: "screenshot"; fullPage?: boolean };

// ---------------------------------------------------------------------------
// Windows computer control (Trice) — UIA-first, coordinate fallback
// ---------------------------------------------------------------------------

/**
 * UI Automation element targeting. Prefer automationId / name / controlType
 * over screen coordinates; coordinates are a fallback only.
 */
export type UiaLocator =
  | { kind: "automationId"; automationId: string }
  | { kind: "name"; name: string; controlType?: string }
  | { kind: "path"; path: string }
  | { kind: "coords"; x: number; y: number };

export type ComputerAction =
  | { type: "move"; locator: UiaLocator }
  | { type: "click"; locator: UiaLocator; button?: "left" | "right" | "middle" }
  | { type: "doubleClick"; locator: UiaLocator }
  | { type: "rightClick"; locator: UiaLocator }
  | { type: "drag"; from: UiaLocator; to: UiaLocator }
  | { type: "scroll"; locator?: UiaLocator; deltaX?: number; deltaY?: number }
  | { type: "type"; text: string; locator?: UiaLocator }
  | { type: "hotkey"; keys: string[] }
  | { type: "focusWindow"; title?: string; processId?: number }
  | { type: "launch"; path: string; args?: string[] }
  | { type: "close"; processId?: number; title?: string }
  | { type: "readUiTree"; root?: UiaLocator; depth?: number }
  | { type: "screenshot"; region?: { x: number; y: number; w: number; h: number } };

/**
 * Result of a BrowserAction or ComputerAction, with verification hooks
 * so the orchestrator can confirm the world changed as expected.
 */
export interface ActionResult {
  actionId: ActionId;
  ok: boolean;
  verified: boolean;
  retries: number;
  exitCode?: number;
  beforeScreenshotRef?: ScreenshotRef;
  afterScreenshotRef?: ScreenshotRef;
  output?: unknown;
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Live computer / browser control session (UI mirror)
// ---------------------------------------------------------------------------

export type ControlSessionKind = "computer" | "browser";

export type ControlSessionStatus =
  | "running"
  | "paused"
  | "stopped"
  | "awaiting_user"
  | "user_controlling";

/**
 * Live view of a worker controlling the computer or browser.
 * UI shows current worker, action, objective, progress; user can
 * pause / stop / takeControl.
 */
export interface ControlSession {
  id: ControlSessionId;
  kind: ControlSessionKind;
  workerId: WorkerId;
  taskId?: TaskId;
  objective: string;
  currentAction?: string;
  progressPercent?: number;
  status: ControlSessionStatus;
  browserSessionId?: BrowserSessionId;
  startedAt: number;
  updatedAt: number;
}

export type ControlSessionCommand =
  | { type: "pause"; sessionId: ControlSessionId }
  | { type: "resume"; sessionId: ControlSessionId }
  | { type: "stop"; sessionId: ControlSessionId }
  | { type: "takeControl"; sessionId: ControlSessionId }
  | { type: "returnControl"; sessionId: ControlSessionId };

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type TaskClass =
  | "simple"
  | "normal"
  | "code"
  | "vision"
  | "reasoning"
  | "frontier";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  name?: string;
  tool_call_id?: string;
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  stop?: string | string[];
  /**
   * Ollama thinking extension (Qwen3 etc.). When true, the model may emit
   * reasoning tokens. Ignored by providers that do not support it.
   */
  think?: boolean;
}

export interface ChatCompletionChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: unknown[];
    };
    finish_reason: string | null;
  }>;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ModelProvider {
  id: string;
  displayName: string;
  listModels(): Promise<string[]>;
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  stream(
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): AsyncIterable<ChatCompletionChunk>;
  isReady(): Promise<boolean>;
}

export interface ModelRouter {
  registerProvider(provider: ModelProvider): void;
  setRoute(taskClass: TaskClass, providerId: string, model: string): void;
  resolve(
    taskClass: TaskClass,
    preferredModel?: string
  ): Promise<{ provider: ModelProvider; model: string }>;
}

/**
 * Embedding provider for semantic memory (Anky). Prefer a small CPU-friendly
 * local model (e.g. nomic-embed-text) so chat GPU VRAM is not stolen.
 */
export interface EmbeddingProvider {
  /** Vector dimensionality for this model. */
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  isReady(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Memory — scoped; never inject whole DB into prompts
// ---------------------------------------------------------------------------

export type MemoryKind = "fact" | "episode" | "procedure" | "preference" | "summary" | "artifact";

export type MemoryScope =
  | { type: "conversation"; conversationId: ConversationId }
  | { type: "worker"; workerId: WorkerId }
  | { type: "user" }
  | { type: "project"; projectId: ProjectId }
  | { type: "team"; teamId: TeamId };

export interface MemoryEntry {
  id: MemoryId;
  kind: MemoryKind;
  content: string;
  /** Optional embedding for semantic retrieve (filled by models layer). */
  embedding?: number[];
  /** Structured facts (key/value) when kind is fact. */
  facts?: Record<string, unknown>;
  scope: MemoryScope;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryWriteInput {
  id?: MemoryId;
  kind: MemoryKind;
  content: string;
  facts?: Record<string, unknown>;
  scope: MemoryScope;
  metadata?: Record<string, unknown>;
  embedding?: number[];
}

export interface MemoryRetrieveQuery {
  /** Semantic / keyword text. */
  text?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  /** Limit results — never dump the whole store into a prompt. */
  limit?: number;
  /** Prefer structured facts matching these keys. */
  factKeys?: string[];
  includeSummaries?: boolean;
}

/**
 * Persistent memory store. Callers must use retrieve() with limits —
 * never inject the whole DB into model context.
 */
export interface MemoryStore {
  write(entry: MemoryWriteInput): Promise<MemoryEntry>;
  retrieve(query: MemoryRetrieveQuery): Promise<MemoryEntry[]>;
  get(id: MemoryId): Promise<MemoryEntry | null>;
  delete(id: MemoryId): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Scheduler / Routines
// ---------------------------------------------------------------------------

export type RoutineSchedule =
  | { type: "cron"; expression: string }
  | { type: "interval"; ms: number }
  | { type: "once"; at: number };

export interface Routine {
  id: RoutineId;
  name: string;
  description: string;
  schedule: RoutineSchedule;
  workerId: WorkerId;
  teamId?: TeamId;
  projectId?: ProjectId;
  taskTemplate: {
    title: string;
    description: string;
    taskClass: TaskClass;
  };
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

export type CalypsoEvent =
  | { type: "worker.status"; workerId: WorkerId; status: WorkerStatus; at: number }
  | { type: "worker.updated"; worker: Worker }
  | { type: "task.created"; task: Task }
  | { type: "task.updated"; task: Task }
  | { type: "task.status"; taskId: TaskId; status: TaskStatus; at: number }
  | { type: "message.created"; message: Message }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "tool.progress"; progress: ToolProgress }
  | { type: "tool.result"; result: ToolResult }
  | { type: "plan.updated"; plan: Plan }
  | { type: "routine.fired"; routineId: RoutineId; taskId: TaskId; at: number }
  | {
      type: "bus.chat";
      fromWorkerId: WorkerId;
      toWorkerIds: WorkerId[];
      teamId?: TeamId;
      content: string;
      taskId?: TaskId;
      at: number;
    }
  /** PermissionGate needs the user to approve/deny a tool call. */
  | {
      type: "permission.asked";
      requestId: string;
      workerId: WorkerId;
      toolCall: ToolCall;
      reason: string;
      at: number;
    }
  | {
      type: "permission.resolved";
      requestId: string;
      allow: boolean;
      at: number;
    }
  | { type: "control.session.updated"; session: ControlSession }
  | { type: "control.session.command"; command: ControlSessionCommand }
  | { type: "control.action"; sessionId: ControlSessionId; actionId: ActionId; summary: string; at: number }
  | { type: "control.action.result"; sessionId: ControlSessionId; result: ActionResult }
  | { type: "project.updated"; project: Project }
  | { type: "artifact.created"; artifact: Artifact }
  | { type: "system.error"; message: string; cause?: string; at: number };

export type CalypsoEventType = CalypsoEvent["type"];

export interface EventBus {
  publish(event: CalypsoEvent): void;
  subscribe(handler: (event: CalypsoEvent) => void): () => void;
  subscribeType<T extends CalypsoEventType>(
    type: T,
    handler: (event: Extract<CalypsoEvent, { type: T }>) => void
  ): () => void;
}

// ---------------------------------------------------------------------------
// Typed IPC / message channel (renderer ↔ core utilityProcess)
// ---------------------------------------------------------------------------

/**
 * Process model:
 *   - Electron main = thin shell (windows, lifecycle)
 *   - packages/core runs in an Electron utilityProcess
 *   - renderer talks to core over this typed message channel
 *   - the same protocol can later be served over localhost WebSocket
 *     so the shell is swappable and the UI stays responsive
 */
export type CoreRequest =
  | { id: string; method: "getAppInfo"; params?: undefined }
  | { id: string; method: "listWorkers"; params?: undefined }
  | { id: string; method: "getTaskGraph"; params?: undefined }
  | {
      id: string;
      method: "sendMessage";
      params: { conversationId: ConversationId; content: string };
    }
  | {
      id: string;
      method: "resolvePermission";
      params: { requestId: string; allow: boolean };
    }
  | {
      id: string;
      method: "controlCommand";
      params: { command: ControlSessionCommand };
    };

export type CoreResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export type CorePush =
  | { channel: "event"; event: CalypsoEvent };

export interface CalypsoIpcApi {
  onEvent(handler: (event: CalypsoEvent) => void): () => void;
  listWorkers(): Promise<Worker[]>;
  getTaskGraph(): Promise<TaskGraph>;
  sendMessage(conversationId: ConversationId, content: string): Promise<Message>;
  resolvePermission(requestId: string, allow: boolean): Promise<void>;
  controlCommand(command: ControlSessionCommand): Promise<void>;
  getAppInfo(): Promise<{ name: string; version: string; platform: string }>;
}

declare global {
  interface Window {
    calypso: CalypsoIpcApi;
  }
}

export {};
