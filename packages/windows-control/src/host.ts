/**
 * Long-lived PowerShell host client (owner: Trice).
 *
 * Spawns `powershell.exe` once with `host/calypso-host.ps1` and talks to it
 * over stdin/stdout JSON lines, so actions don't pay PowerShell startup cost.
 * The host is single-threaded: requests run in order. A request that hangs
 * past its timeout kills and restarts the host so one stuck UI call can't
 * wedge computer control.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostRequest, HostRequestBody, HostResponse } from "./protocol.js";

export type { HostRequest, HostResponse } from "./protocol.js";

export interface PowerShellHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  request(req: HostRequest, timeoutMs?: number): Promise<HostResponse>;
  /** Abort whatever input action is in flight and refuse new input until cleared. */
  raiseStopFlag(): void;
  clearStopFlag(): void;
  get running(): boolean;
}

export interface ProcessPowerShellHostOptions {
  /** Executable. Default `powershell.exe` (Windows PowerShell 5.1, always installed). */
  command?: string;
  /** Path to calypso-host.ps1. Default: bundled script, or CALYPSO_PS_HOST_SCRIPT. */
  scriptPath?: string;
  /** Override full argv (tests). When set, scriptPath is ignored. */
  args?: string[];
  /** Folder for screenshot files. */
  screenshotDir?: string;
  /** Default per-request timeout. */
  requestTimeoutMs?: number;
  /** How long to wait for the host's ready line. */
  startTimeoutMs?: number;
  /** Restart automatically if the host exits unexpectedly. Default true. */
  autoRestart?: boolean;
  onLog?: (line: string) => void;
}

/** Resolve the bundled host script; in a packaged app it must be asar-unpacked. */
export function defaultHostScriptPath(): string {
  if (process.env.CALYPSO_PS_HOST_SCRIPT && existsSync(process.env.CALYPSO_PS_HOST_SCRIPT)) {
    return process.env.CALYPSO_PS_HOST_SCRIPT;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const unpack = (p: string) =>
    p.replace(`app.asar${"\\"}`, `app.asar.unpacked${"\\"}`).replace("app.asar/", "app.asar.unpacked/");
  const candidates = [
    process.env.CALYPSO_PS_HOST_SCRIPT,
    typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
      ? join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath!, "windows-control-host", "calypso-host.ps1")
      : undefined,
    join(here, "..", "host", "calypso-host.ps1"),
  ].filter((p): p is string => !!p);
  for (const raw of candidates) {
    const p = unpack(raw);
    if (existsSync(p)) return p;
  }
  return unpack(candidates[0] ?? join(here, "..", "host", "calypso-host.ps1"));
}

interface Pending {
  resolve: (res: HostResponse) => void;
  timer: NodeJS.Timeout;
}

let seq = 0;
export function nextRequestId(prefix = "rq"): string {
  return `${prefix}_${++seq}_${Date.now().toString(36)}`;
}

export class ProcessPowerShellHost implements PowerShellHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private starting: Promise<void> | null = null;
  private stopping = false;
  private readonly opts: Required<Omit<ProcessPowerShellHostOptions, "args" | "onLog">> &
    Pick<ProcessPowerShellHostOptions, "args" | "onLog">;
  readonly stopFlagPath: string;

  constructor(options: ProcessPowerShellHostOptions = {}) {
    const base = join(tmpdir(), "calypso");
    this.opts = {
      command: options.command ?? "powershell.exe",
      scriptPath: options.scriptPath ?? defaultHostScriptPath(),
      args: options.args,
      screenshotDir: options.screenshotDir ?? join(base, "screens"),
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      startTimeoutMs: options.startTimeoutMs ?? 20_000,
      autoRestart: options.autoRestart ?? true,
      onLog: options.onLog,
    };
    mkdirSync(base, { recursive: true });
    this.stopFlagPath = join(base, `stop-${process.pid}.flag`);
    this.clearStopFlag();
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.starting === null;
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.spawnHost().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawnHost(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = this.opts.args ?? [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.opts.scriptPath,
        "-StopFlag",
        this.stopFlagPath,
        "-ScreenshotDir",
        this.opts.screenshotDir,
      ];
      let settled = false;
      const child = spawn(this.opts.command, args, { windowsHide: true, stdio: "pipe" });
      this.child = child;
      this.buffer = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`PowerShell host did not become ready within ${this.opts.startTimeoutMs} ms`));
      }, this.opts.startTimeoutMs);

      child.stdout.on("data", (chunk: string) => {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          let msg: HostResponse;
          try {
            msg = JSON.parse(line) as HostResponse;
          } catch {
            this.opts.onLog?.(`[host stdout] ${line}`);
            continue;
          }
          if (msg.id === "_ready") {
            if (!settled) {
              settled = true;
              clearTimeout(readyTimer);
              resolve();
            }
            continue;
          }
          const p = this.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            p.resolve(msg);
          }
        }
      });
      child.stderr.on("data", (chunk: string) => this.opts.onLog?.(`[host stderr] ${chunk.trimEnd()}`));
      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(err);
        }
      });
      child.on("exit", (code) => {
        if (this.child === child) this.child = null;
        this.failAll("host_crashed", `PowerShell host exited (code ${code ?? "null"})`);
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(new Error(`PowerShell host exited before ready (code ${code ?? "null"})`));
          return;
        }
        if (!this.stopping && this.opts.autoRestart) {
          this.opts.onLog?.("[host] restarting after unexpected exit");
          this.start().catch((e) => this.opts.onLog?.(`[host] restart failed: ${String(e)}`));
        }
      });
    });
  }

  private failAll(code: "host_crashed" | "timeout", error: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ id, ok: false, error, code });
    }
    this.pending.clear();
  }

  async request(req: HostRequest, timeoutMs?: number): Promise<HostResponse> {
    if (!this.running) {
      try {
        await this.start();
      } catch (e) {
        return { id: req.id, ok: false, error: `PowerShell host unavailable: ${String(e)}`, code: "host_unavailable" };
      }
    }
    const child = this.child;
    if (!child) return { id: req.id, ok: false, error: "PowerShell host not running", code: "host_unavailable" };
    const limit = timeoutMs ?? this.opts.requestTimeoutMs;
    return new Promise<HostResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        resolve({ id: req.id, ok: false, error: `Host request '${req.method}' timed out after ${limit} ms`, code: "timeout" });
        // A stuck host blocks every later request: recycle it.
        this.opts.onLog?.(`[host] ${req.method} timed out; recycling host`);
        child.kill();
      }, limit);
      this.pending.set(req.id, { resolve, timer });
      child.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  /** Convenience: send a request body and get an auto-generated id. */
  call(body: HostRequestBody, timeoutMs?: number): Promise<HostResponse> {
    return this.request({ id: nextRequestId(body.method), ...body } as HostRequest, timeoutMs);
  }

  raiseStopFlag(): void {
    try {
      writeFileSync(this.stopFlagPath, String(Date.now()));
    } catch {
      /* best effort */
    }
  }

  clearStopFlag(): void {
    try {
      if (existsSync(this.stopFlagPath)) rmSync(this.stopFlagPath, { force: true });
    } catch {
      /* best effort */
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.stdin.write(JSON.stringify({ id: "_shutdown", method: "shutdown" }) + "\n");
        child.stdin.end();
      } catch {
        child.kill();
      }
    });
    this.child = null;
    this.clearStopFlag();
  }
}

/** Used off-Windows (dev boxes, CI) so the rest of Calypso still runs. */
export class StubPowerShellHost implements PowerShellHost {
  private _running = false;
  constructor(private reason = "Windows computer control is only available on Windows") {}
  get running(): boolean {
    return this._running;
  }
  async start(): Promise<void> {
    this._running = true;
  }
  async stop(): Promise<void> {
    this._running = false;
  }
  raiseStopFlag(): void {}
  clearStopFlag(): void {}
  async request(req: HostRequest): Promise<HostResponse> {
    return { id: req.id, ok: false, error: this.reason, code: "host_unavailable" };
  }
}

export function createDefaultHost(options?: ProcessPowerShellHostOptions): PowerShellHost {
  return process.platform === "win32" ? new ProcessPowerShellHost(options) : new StubPowerShellHost();
}
