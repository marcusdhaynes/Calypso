import type {
  BrowserAction,
  BrowserSessionId,
  Tool,
  ToolCall,
  ToolResult,
} from "@calypso/shared";
import { runBrowserAction } from "./actions.js";
import type { BrowserSessionManager } from "./session.js";

function toolClassForAction(action: BrowserAction): Tool["toolClass"] {
  switch (action.type) {
    case "navigate":
      return "network";
    case "download":
      return "browser_download";
    case "upload":
      return "browser_upload";
    case "screenshot":
    case "extract":
    case "switchTab":
      return "read";
    case "closeTab":
      return "write";
    default:
      return "write";
  }
}

async function gatedExecute(
  manager: BrowserSessionManager,
  sessionId: BrowserSessionId,
  action: BrowserAction,
  toolName: string,
  params: Record<string, unknown>,
  ctx: Parameters<Tool["execute"]>[1],
): Promise<ToolResult> {
  const started = Date.now();
  const toolClass = toolClassForAction(action);

  // Off-origin navigate upgrades the class so the gate can ask/deny
  if (action.type === "navigate" && !manager.isOriginAllowed(sessionId, action.url)) {
    const call: ToolCall = {
      id: ctx.toolCallId,
      toolName,
      toolClass: "browser_offorigin_nav",
      params,
      workerId: ctx.workerId,
      taskId: ctx.taskId,
      status: "pending",
      createdAt: Date.now(),
    };
    const decision = await ctx.gate.check(ctx.worker, call);
    if (decision.decision === "deny") {
      return {
        toolCallId: ctx.toolCallId,
        ok: false,
        error: decision.reason,
        durationMs: Date.now() - started,
      };
    }
    if (decision.decision === "ask") {
      return {
        toolCallId: ctx.toolCallId,
        ok: false,
        error: `awaiting_permission:${decision.requestId}`,
        durationMs: Date.now() - started,
      };
    }
    try {
      manager.allowOrigin(sessionId, new URL(action.url).origin);
    } catch {
      /* ignore */
    }
  } else {
    const call: ToolCall = {
      id: ctx.toolCallId,
      toolName,
      toolClass,
      params,
      workerId: ctx.workerId,
      taskId: ctx.taskId,
      status: "pending",
      createdAt: Date.now(),
    };
    const decision = await ctx.gate.check(ctx.worker, call);
    if (decision.decision === "deny") {
      return {
        toolCallId: ctx.toolCallId,
        ok: false,
        error: decision.reason,
        durationMs: Date.now() - started,
      };
    }
    if (decision.decision === "ask") {
      return {
        toolCallId: ctx.toolCallId,
        ok: false,
        error: `awaiting_permission:${decision.requestId}`,
        durationMs: Date.now() - started,
      };
    }
  }

  ctx.onProgress({
    toolCallId: ctx.toolCallId,
    message: `browser.${action.type}`,
  });

  const result = await runBrowserAction(manager, {
    sessionId,
    action,
    signal: ctx.signal,
  });

  return {
    toolCallId: ctx.toolCallId,
    ok: result.ok && result.verified,
    output: result,
    error: result.error,
    durationMs: Date.now() - started,
  };
}

function sessionIdFor(params: Record<string, unknown>, workerId: string): BrowserSessionId {
  const raw = typeof params.sessionId === "string" && params.sessionId ? params.sessionId : `worker-${workerId}`;
  // Model-supplied ids end up in a filesystem path; keep them safe.
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || `worker-${workerId}`;
}

/**
 * Resolve the worker's browser session, opening it on first use. The model
 * should not have to know a session id: omitted or unknown ids map to a
 * per-worker session instead of failing the whole reply.
 */
async function ensureSession(
  manager: BrowserSessionManager,
  params: Record<string, unknown>,
  ctx: Parameters<Tool["execute"]>[1],
): Promise<BrowserSessionId> {
  let id = sessionIdFor(params, ctx.workerId);
  if (!manager.getSession(id)) {
    const fallback = `worker-${ctx.workerId}`.replace(/[^A-Za-z0-9_-]/g, "_");
    if (manager.getSession(fallback)) {
      id = fallback;
    } else {
      await manager.openSession({ workerId: ctx.workerId, sessionId: fallback });
      id = fallback;
    }
  }
  return id;
}

/** Build the full browser tool set bound to a shared session manager. */
export function createBrowserTools(manager: BrowserSessionManager): Tool[] {
  const navigate: Tool = {
    name: "browser.navigate",
    description: "Navigate to a URL; host verifies landed URL + non-empty body (retries on fail).",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional. Omit to use your own browser session." },
        url: { type: "string", description: "Absolute URL" },
      },
      required: ["url"],
    },
    toolClass: "network",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        await ensureSession(manager, params, ctx),
        { type: "navigate", url: String(params.url) },
        "browser.navigate",
        params,
        ctx,
      );
    },
  };

  const click: Tool = {
    name: "browser.click",
    description: "Click an element via DomLocator (role/label/text/css/testId/xpath).",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional. Omit to use your own browser session." },
        locator: { type: "object" },
      },
      required: ["locator"],
    },
    toolClass: "write",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        await ensureSession(manager, params, ctx),
        { type: "click", locator: params.locator as never },
        "browser.click",
        params,
        ctx,
      );
    },
  };

  const type: Tool = {
    name: "browser.type",
    description: "Type into an element via DomLocator.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional. Omit to use your own browser session." },
        locator: { type: "object" },
        text: { type: "string" },
        clear: { type: "boolean" },
      },
      required: ["locator", "text"],
    },
    toolClass: "write",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        await ensureSession(manager, params, ctx),
        {
          type: "type",
          locator: params.locator as never,
          text: String(params.text),
          clear: Boolean(params.clear),
        },
        "browser.type",
        params,
        ctx,
      );
    },
  };

  const extract: Tool = {
    name: "browser.extract",
    description: "Extract text from the page or a DomLocator; empty text fails verify and retries.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional. Omit to use your own browser session." },
        locator: { type: "object" },
      },
      required: [],
    },
    toolClass: "read",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        await ensureSession(manager, params, ctx),
        {
          type: "extract",
          locator: params.locator as never | undefined,
        },
        "browser.extract",
        params,
        ctx,
      );
    },
  };

  const snapshot: Tool = {
    name: "browser.snapshot",
    description: "Screenshot the current page (and optionally return accessibility-oriented extract).",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional. Omit to use your own browser session." },
        fullPage: { type: "boolean" },
        includeText: { type: "boolean" },
      },
      required: [],
    },
    toolClass: "read",
    async execute(params, ctx) {
      const sessionId = await ensureSession(manager, params, ctx);
      const shot = await gatedExecute(
        manager,
        sessionId,
        { type: "screenshot", fullPage: Boolean(params.fullPage) },
        "browser.snapshot",
        params,
        ctx,
      );
      if (!params.includeText || !shot.ok) return shot;
      const text = await gatedExecute(
        manager,
        sessionId,
        { type: "extract" },
        "browser.snapshot",
        params,
        ctx,
      );
      return {
        ...shot,
        output: { screenshot: shot.output, extract: text.output },
      };
    },
  };

  const newTab: Tool = {
    name: "browser.newTab",
    description: "Open a new tab in the worker's browser session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional. Omit to use your own browser session." },
        url: { type: "string" },
      },
      required: [],
    },
    toolClass: "network",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        await ensureSession(manager, params, ctx),
        { type: "newTab", url: params.url ? String(params.url) : undefined },
        "browser.newTab",
        params,
        ctx,
      );
    },
  };

  const upload: Tool = {
    name: "browser.upload",
    description: "Upload files to a file input via DomLocator.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional. Omit to use your own browser session." },
        locator: { type: "object" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["locator", "files"],
    },
    toolClass: "browser_upload",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        await ensureSession(manager, params, ctx),
        {
          type: "upload",
          locator: params.locator as never,
          files: params.files as string[],
        },
        "browser.upload",
        params,
        ctx,
      );
    },
  };

  const download: Tool = {
    name: "browser.download",
    description: "Click an element and save the resulting download.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional. Omit to use your own browser session." },
        locator: { type: "object" },
        saveAs: { type: "string" },
      },
      required: ["locator"],
    },
    toolClass: "browser_download",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        await ensureSession(manager, params, ctx),
        {
          type: "download",
          locator: params.locator as never,
          saveAs: params.saveAs ? String(params.saveAs) : undefined,
        },
        "browser.download",
        params,
        ctx,
      );
    },
  };

  return [navigate, click, type, extract, snapshot, newTab, upload, download];
}
