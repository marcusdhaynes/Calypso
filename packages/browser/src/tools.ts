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

function requireSessionId(params: Record<string, unknown>): BrowserSessionId {
  const id = params.sessionId;
  if (typeof id !== "string" || !id) {
    throw new Error("sessionId is required");
  }
  return id;
}

/** Build the full browser tool set bound to a shared session manager. */
export function createBrowserTools(manager: BrowserSessionManager): Tool[] {
  const navigate: Tool = {
    name: "browser.navigate",
    description: "Navigate the worker's browser session to a URL (DOM-verified).",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        url: { type: "string", description: "Absolute URL" },
      },
      required: ["sessionId", "url"],
    },
    toolClass: "network",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        requireSessionId(params),
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
        sessionId: { type: "string" },
        locator: { type: "object" },
      },
      required: ["sessionId", "locator"],
    },
    toolClass: "write",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        requireSessionId(params),
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
        sessionId: { type: "string" },
        locator: { type: "object" },
        text: { type: "string" },
        clear: { type: "boolean" },
      },
      required: ["sessionId", "locator", "text"],
    },
    toolClass: "write",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        requireSessionId(params),
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
    description: "Extract text from the page or a DomLocator.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        locator: { type: "object" },
      },
      required: ["sessionId"],
    },
    toolClass: "read",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        requireSessionId(params),
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
        sessionId: { type: "string" },
        fullPage: { type: "boolean" },
        includeText: { type: "boolean" },
      },
      required: ["sessionId"],
    },
    toolClass: "read",
    async execute(params, ctx) {
      const sessionId = requireSessionId(params);
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
        sessionId: { type: "string" },
        url: { type: "string" },
      },
      required: ["sessionId"],
    },
    toolClass: "network",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        requireSessionId(params),
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
        sessionId: { type: "string" },
        locator: { type: "object" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["sessionId", "locator", "files"],
    },
    toolClass: "browser_upload",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        requireSessionId(params),
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
        sessionId: { type: "string" },
        locator: { type: "object" },
        saveAs: { type: "string" },
      },
      required: ["sessionId", "locator"],
    },
    toolClass: "browser_download",
    async execute(params, ctx) {
      return gatedExecute(
        manager,
        requireSessionId(params),
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
