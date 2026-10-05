/**
 * Worker-facing tools for Windows computer control (owner: Trice).
 * Each tool declares a ToolClass and calls the PermissionGate before acting.
 *
 *   windows.computer      input_control  mouse, keyboard, focus, scroll, drag
 *   windows.observe       read           screenshot, UI tree, windows, processes
 *   windows.launch_app    process        start a program / file / URI
 *   windows.close_app     process        graceful close (force=true → destructive)
 *   windows.powershell    process        run a PowerShell command (separate process)
 */
import { spawn } from "node:child_process";
import type {
  ComputerAction,
  Tool,
  ToolCall,
  ToolClass,
  ToolExecutionContext,
  ToolResult,
} from "@calypso/shared";
import type { ComputerController } from "./control.js";
import type { HostComputerAction } from "./protocol.js";

async function checkGate(
  ctx: ToolExecutionContext,
  toolName: string,
  toolClass: ToolClass,
  params: Record<string, unknown>
): Promise<string | null> {
  const call: ToolCall = {
    id: ctx.toolCallId,
    toolName,
    toolClass,
    params,
    workerId: ctx.workerId,
    taskId: ctx.taskId,
    status: "awaiting_permission",
    createdAt: Date.now(),
  };
  const d = await ctx.gate.check(ctx.worker, call);
  if (d.decision === "allow") return null;
  return d.decision === "deny" ? d.reason : "Permission not granted";
}

function done(ctx: ToolExecutionContext, started: number, ok: boolean, output?: unknown, error?: string): ToolResult {
  return { toolCallId: ctx.toolCallId, ok, output, error, durationMs: Date.now() - started };
}

const locatorSchema = {
  type: "object",
  description:
    'UI element target. Prefer {"kind":"name","name":"Save","controlType":"Button"} or {"kind":"automationId",...}; ' +
    'path is "ControlType[prop=value]/ControlType#index"; use {"kind":"coords","x":..,"y":..} only when no element is reachable.',
  properties: {
    kind: { type: "string", enum: ["automationId", "name", "path", "coords"] },
    automationId: { type: "string" },
    name: { type: "string" },
    controlType: { type: "string" },
    path: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
  },
  required: ["kind"],
};

function objective(ctx: ToolExecutionContext, params: Record<string, unknown>): string {
  return typeof params.objective === "string" && params.objective ? params.objective : ctx.taskId ? `Task ${ctx.taskId}` : "Using the computer";
}

const INPUT_TYPES = ["move", "click", "doubleClick", "rightClick", "drag", "scroll", "type", "hotkey", "focusWindow"] as const;

export function createComputerTool(controller: ComputerController): Tool {
  const name = "windows.computer";
  return {
    name,
    description:
      "Operate the Windows desktop with the real mouse and keyboard: click, double-click, right-click, drag, scroll, type, press hotkeys, or switch windows. " +
      "Targets UI Automation elements first (clicks use the element's Invoke/Toggle/Select when it has one) and falls back to coordinates. " +
      "The user can pause, stop, or take over at any time; a result with code user_input or stopped means stop and wait.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "object",
          description: `A ComputerAction: {"type": one of ${INPUT_TYPES.join(", ")}, ...fields}`,
          properties: {
            type: { type: "string", enum: [...INPUT_TYPES] },
            locator: locatorSchema,
            from: locatorSchema,
            to: locatorSchema,
            button: { type: "string", enum: ["left", "right", "middle"] },
            text: { type: "string" },
            keys: { type: "array", items: { type: "string" }, description: 'e.g. ["ctrl","s"]' },
            deltaX: { type: "number", description: "wheel notches, positive = right" },
            deltaY: { type: "number", description: "wheel notches, positive = down" },
            title: { type: "string" },
            processId: { type: "number" },
            forceMouse: { type: "boolean" },
            forceKeys: { type: "boolean" },
            append: { type: "boolean" },
          },
          required: ["type"],
        },
        objective: { type: "string", description: "What you're trying to accomplish; shown in the live view." },
        verifyWithScreenshot: { type: "boolean", description: "Capture an after-screenshot (default true)." },
      },
      required: ["action"],
    },
    toolClass: "input_control",
    async execute(params, ctx) {
      const started = Date.now();
      const action = params.action as HostComputerAction | undefined;
      if (!action || !INPUT_TYPES.includes(action.type as (typeof INPUT_TYPES)[number])) {
        return done(ctx, started, false, undefined, `action.type must be one of ${INPUT_TYPES.join(", ")}`);
      }
      const denied = await checkGate(ctx, name, "input_control", params);
      if (denied) return done(ctx, started, false, undefined, denied);
      const session = controller.openSession({ workerId: ctx.workerId, taskId: ctx.taskId, objective: objective(ctx, params) });
      ctx.onProgress({ toolCallId: ctx.toolCallId, message: "Controlling the computer", data: { sessionId: session.id } });
      const result = await controller.execute(session.id, action, {
        captureAfter: params.verifyWithScreenshot !== false,
        signal: ctx.signal,
      });
      return done(ctx, started, result.ok, { ...result, sessionId: session.id }, result.error);
    },
  };
}

export function createObserveTool(controller: ComputerController): Tool {
  const name = "windows.observe";
  const what = ["screenshot", "uiTree", "findElement", "windows", "processes", "screens", "cursor"] as const;
  return {
    name,
    description:
      "Look at the Windows desktop without changing anything: take a screenshot (for the vision model), read the UI Automation tree of the " +
      "foreground window or an element, find an element, or list windows, processes, monitors and the cursor position.",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", enum: [...what] },
        region: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } } },
        maxWidth: { type: "number", description: "screenshot: downscale to this width (vision models like ≤1280)" },
        inline: { type: "boolean", description: "screenshot: return base64 instead of a file path" },
        root: locatorSchema,
        locator: locatorSchema,
        depth: { type: "number" },
        maxNodes: { type: "number" },
        withWindowsOnly: { type: "boolean" },
      },
      required: ["what"],
    },
    toolClass: "read",
    async execute(params, ctx) {
      const started = Date.now();
      const denied = await checkGate(ctx, name, "read", params);
      if (denied) return done(ctx, started, false, undefined, denied);
      let res;
      switch (params.what) {
        case "screenshot":
          res = await controller.query({
            method: "screenshot",
            format: "png",
            region: params.region,
            maxWidth: params.maxWidth,
            inline: params.inline === true,
          });
          break;
        case "uiTree":
          res = await controller.query({
            method: "action",
            action: { type: "readUiTree", root: params.root, depth: params.depth, maxNodes: params.maxNodes },
          });
          break;
        case "findElement":
          if (!params.locator) return done(ctx, started, false, undefined, "findElement needs a locator");
          res = await controller.query({ method: "findElement", locator: params.locator });
          break;
        case "windows":
          res = await controller.query({ method: "listWindows" });
          break;
        case "processes":
          res = await controller.query({ method: "listProcesses", withWindowsOnly: params.withWindowsOnly === true });
          break;
        case "screens":
          res = await controller.query({ method: "screenInfo" });
          break;
        case "cursor":
          res = await controller.query({ method: "cursor" });
          break;
        default:
          return done(ctx, started, false, undefined, `what must be one of ${what.join(", ")}`);
      }
      return res.ok ? done(ctx, started, true, res.result) : done(ctx, started, false, { code: res.code }, res.error);
    },
  };
}

export function createLaunchTool(controller: ComputerController): Tool {
  const name = "windows.launch_app";
  return {
    name,
    description:
      "Open a program, file, folder, or URI on Windows (e.g. \"notepad\", \"C:\\\\Tools\\\\app.exe\", \"ms-settings:\"). Waits for its window and returns its process id.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        waitMs: { type: "number" },
        objective: { type: "string" },
      },
      required: ["path"],
    },
    toolClass: "process",
    async execute(params, ctx) {
      const started = Date.now();
      if (typeof params.path !== "string" || !params.path) return done(ctx, started, false, undefined, "path is required");
      const denied = await checkGate(ctx, name, "process", params);
      if (denied) return done(ctx, started, false, undefined, denied);
      const session = controller.openSession({ workerId: ctx.workerId, taskId: ctx.taskId, objective: objective(ctx, params) });
      const action: HostComputerAction = {
        type: "launch",
        path: params.path,
        args: Array.isArray(params.args) ? (params.args as string[]) : undefined,
        cwd: typeof params.cwd === "string" ? params.cwd : undefined,
        waitMs: typeof params.waitMs === "number" ? params.waitMs : undefined,
      };
      const result = await controller.execute(session.id, action, { captureAfter: true, retries: 0, signal: ctx.signal });
      return done(ctx, started, result.ok, { ...result, sessionId: session.id }, result.error);
    },
  };
}

export function createCloseTool(controller: ComputerController): Tool {
  const name = "windows.close_app";
  return {
    name,
    description:
      "Close an application by process id or window title. Asks the app to close normally (it may prompt to save). " +
      "force=true kills it if it won't close, which can lose unsaved work and is treated as destructive.",
    parameters: {
      type: "object",
      properties: {
        processId: { type: "number" },
        title: { type: "string" },
        force: { type: "boolean" },
        waitMs: { type: "number" },
        objective: { type: "string" },
      },
    },
    toolClass: "process",
    async execute(params, ctx) {
      const started = Date.now();
      if (typeof params.processId !== "number" && typeof params.title !== "string") {
        return done(ctx, started, false, undefined, "processId or title is required");
      }
      const force = params.force === true;
      const denied = await checkGate(ctx, name, force ? "destructive" : "process", params);
      if (denied) return done(ctx, started, false, undefined, denied);
      const session = controller.openSession({ workerId: ctx.workerId, taskId: ctx.taskId, objective: objective(ctx, params) });
      const action: HostComputerAction = {
        type: "close",
        processId: typeof params.processId === "number" ? params.processId : undefined,
        title: typeof params.title === "string" ? params.title : undefined,
        force,
        waitMs: typeof params.waitMs === "number" ? params.waitMs : undefined,
      };
      const result = await controller.execute(session.id, action, { captureAfter: false, retries: 0, signal: ctx.signal });
      return done(ctx, started, result.ok, { ...result, sessionId: session.id }, result.error);
    },
  };
}

export interface PowerShellRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/** Run one PowerShell command in its own process (never in the control host, so it can't block input). */
export function runPowerShell(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; exe?: string; maxOutputBytes?: number } = {}
): Promise<PowerShellRunResult> {
  const exe = opts.exe ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");
  const max = opts.maxOutputBytes ?? 256 * 1024;
  // -EncodedCommand avoids every quoting problem with arbitrary scripts.
  const wrapped = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  return new Promise((resolve) => {
    const child = spawn(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      cwd: opts.cwd,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const take = (cur: string, chunk: Buffer) => {
      if (cur.length >= max) {
        truncated = true;
        return cur;
      }
      const next = cur + chunk.toString("utf8");
      if (next.length > max) truncated = true;
      return next.slice(0, max);
    };
    child.stdout.on("data", (c: Buffer) => (stdout = take(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = take(stderr, c)));
    const kill = () => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? 120_000);
    const onAbort = () => kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, timedOut, truncated });
    };
    child.on("error", (e) => {
      stderr += String(e);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

export function createPowerShellTool(): Tool {
  const name = "windows.powershell";
  return {
    name,
    description:
      "Run a PowerShell command or script on Windows and get stdout, stderr and the exit code. Each call runs in a fresh process. " +
      "Check exitCode before continuing.",
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
    async execute(params, ctx) {
      const started = Date.now();
      if (typeof params.command !== "string" || !params.command.trim()) {
        return done(ctx, started, false, undefined, "command is required");
      }
      const denied = await checkGate(ctx, name, "process", params);
      if (denied) return done(ctx, started, false, undefined, denied);
      ctx.onProgress({ toolCallId: ctx.toolCallId, message: "Running PowerShell" });
      const r = await runPowerShell(params.command, {
        cwd: typeof params.cwd === "string" ? params.cwd : ctx.worker.workspace || undefined,
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
        signal: ctx.signal,
      });
      const ok = r.exitCode === 0 && !r.timedOut;
      const error = r.timedOut ? "Timed out" : ok ? undefined : `Exit code ${r.exitCode}${r.stderr ? `: ${r.stderr.slice(0, 500)}` : ""}`;
      return done(ctx, started, ok, r, error);
    },
  };
}

/** Back-compat helper: run a raw ComputerAction for a worker (used by orchestrator integration tests). */
export async function runComputerAction(
  controller: ComputerController,
  action: ComputerAction,
  workerId: string,
  objectiveText = "Using the computer"
) {
  const session = controller.openSession({ workerId, objective: objectiveText });
  return controller.execute(session.id, action);
}
