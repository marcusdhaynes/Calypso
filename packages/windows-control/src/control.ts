/**
 * Computer control sessions (owner: Trice).
 *
 * There is one physical mouse and keyboard, so only one worker controls the
 * computer at a time; others wait in a FIFO queue. The controller:
 *  - runs every ComputerAction through the PowerShell host with retries,
 *    verification and optional before/after screenshots
 *  - handles Pause / Resume / Stop / Take Control / Return Control from the UI
 *    (raising the host stop flag aborts an in-flight action immediately)
 *  - watches for real user mouse/keyboard input and hands control back to
 *    the user automatically ("user_controlling")
 *  - streams live JPEG frames as `control.frame` events while someone watches
 */
import type {
  ActionResult,
  CalypsoEvent,
  ComputerAction,
  ControlFrame,
  ControlSession,
  ControlSessionCommand,
  ControlSessionId,
  TaskId,
  WorkerId,
} from "@calypso/shared";
import { nextRequestId, type PowerShellHost } from "./host.js";
import type { HostComputerAction, HostErrorCode, HostResponse, InputState, ScreenshotResult } from "./protocol.js";

export interface EventPublisher {
  publish(event: CalypsoEvent): void;
}

export interface ExecuteOptions {
  /** Capture a screenshot before the action (file ref). */
  captureBefore?: boolean;
  /** Capture a screenshot after the action so Observe/Verify can check it. Default true for input actions. */
  captureAfter?: boolean;
  /** Retries for not_found / not_clickable (UI still rendering). Default 2. */
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ControllerOptions {
  /** Poll interval for the user-input watcher. Default 350 ms. */
  inputPollMs?: number;
  /** User input this far past the agent's last injection means the user took over. Default 400 ms. */
  userInputThresholdMs?: number;
  /** Frames per second for the live view. Default 2. */
  frameFps?: number;
  /** Max frame width for the live view. Default 1280. */
  frameMaxWidth?: number;
  /** Delay after an input action before the after-screenshot. Default 250 ms. */
  settleMs?: number;
}

export class ControlInterruptedError extends Error {
  constructor(public code: "stopped" | "user_input" | "paused", message: string) {
    super(message);
  }
}

const INPUT_ACTIONS = new Set<ComputerAction["type"]>([
  "move",
  "click",
  "doubleClick",
  "rightClick",
  "drag",
  "scroll",
  "type",
  "hotkey",
  "focusWindow",
]);

const RETRYABLE: HostErrorCode[] = ["not_found", "not_clickable"];

interface SessionState {
  session: ControlSession;
  waiters: Array<() => void>;
}

let sessionSeq = 0;
let actionSeq = 0;

export function describeAction(a: ComputerAction): string {
  const loc = (l?: { kind: string; [k: string]: unknown }) => {
    if (!l) return "";
    switch (l.kind) {
      case "name":
        return ` "${String(l.name)}"`;
      case "automationId":
        return ` #${String(l.automationId)}`;
      case "path":
        return ` ${String(l.path)}`;
      case "coords":
        return ` at (${String(l.x)}, ${String(l.y)})`;
      default:
        return "";
    }
  };
  switch (a.type) {
    case "move":
      return `Move to${loc(a.locator)}`;
    case "click":
      return `${a.button && a.button !== "left" ? `${a.button[0].toUpperCase()}${a.button.slice(1)}-click` : "Click"}${loc(a.locator)}`;
    case "doubleClick":
      return `Double-click${loc(a.locator)}`;
    case "rightClick":
      return `Right-click${loc(a.locator)}`;
    case "drag":
      return `Drag${loc(a.from)} to${loc(a.to)}`;
    case "scroll":
      return `Scroll${a.deltaY ? (a.deltaY > 0 ? " down" : " up") : ""}${a.deltaX ? (a.deltaX > 0 ? " right" : " left") : ""}${loc(a.locator)}`;
    case "type": {
      const preview = a.text.length > 40 ? `${a.text.slice(0, 40)}…` : a.text;
      return `Type "${preview}"${a.locator ? ` into${loc(a.locator)}` : ""}`;
    }
    case "hotkey":
      return `Press ${a.keys.join("+")}`;
    case "focusWindow":
      return `Switch to ${a.title ? `"${a.title}"` : `process ${a.processId ?? "?"}`}`;
    case "launch":
      return `Open ${a.path}`;
    case "close":
      return `Close ${a.title ? `"${a.title}"` : `process ${a.processId ?? "?"}`}`;
    case "readUiTree":
      return "Read the window's controls";
    case "screenshot":
      return "Look at the screen";
  }
}

export class ComputerController {
  private sessions = new Map<ControlSessionId, SessionState>();
  /** Session currently holding the mouse/keyboard. */
  private owner: ControlSessionId | null = null;
  private queue: Array<{ sessionId: ControlSessionId; grant: () => void }> = [];
  private executing = false;
  private releaseAfterAction = false;
  private inputTimer: NodeJS.Timeout | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private frameBusy = false;
  private watchers = 0;
  private baselineInputTick = 0;
  private readonly o: Required<ControllerOptions>;

  constructor(
    private host: PowerShellHost,
    private bus?: EventPublisher,
    options: ControllerOptions = {}
  ) {
    this.o = {
      inputPollMs: options.inputPollMs ?? 350,
      userInputThresholdMs: options.userInputThresholdMs ?? 400,
      frameFps: options.frameFps ?? 2,
      frameMaxWidth: options.frameMaxWidth ?? 1280,
      settleMs: options.settleMs ?? 250,
    };
  }

  // ---------------------------------------------------------------- sessions

  listSessions(): ControlSession[] {
    return [...this.sessions.values()].map((s) => s.session);
  }

  getSession(id: ControlSessionId): ControlSession | undefined {
    return this.sessions.get(id)?.session;
  }

  /** Active (not stopped) session for a worker, if any. */
  findWorkerSession(workerId: WorkerId): ControlSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.session.workerId === workerId && s.session.status !== "stopped") return s.session;
    }
    return undefined;
  }

  /** Start a session, or return the worker's existing one. */
  openSession(input: { workerId: WorkerId; taskId?: TaskId; objective: string }): ControlSession {
    const existing = this.findWorkerSession(input.workerId);
    if (existing) {
      if (input.objective && input.objective !== existing.objective) {
        this.update(existing.id, { objective: input.objective, taskId: input.taskId ?? existing.taskId });
      }
      return this.sessions.get(existing.id)!.session;
    }
    const now = Date.now();
    const session: ControlSession = {
      id: `cs_${++sessionSeq}_${now.toString(36)}`,
      kind: "computer",
      workerId: input.workerId,
      taskId: input.taskId,
      objective: input.objective,
      status: "running",
      startedAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, { session, waiters: [] });
    this.publish({ type: "control.session.updated", session });
    return session;
  }

  /** End a session normally (task finished). */
  closeSession(id: ControlSessionId): void {
    const s = this.sessions.get(id);
    if (!s || s.session.status === "stopped") return;
    this.update(id, { status: "stopped", currentAction: undefined });
    this.release(id);
    this.wake(id);
  }

  private update(id: ControlSessionId, patch: Partial<ControlSession>): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.session = { ...s.session, ...patch, updatedAt: Date.now() };
    this.publish({ type: "control.session.updated", session: s.session });
  }

  private wake(id: ControlSessionId): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const w = s.waiters.splice(0);
    w.forEach((fn) => fn());
  }

  private publish(event: CalypsoEvent): void {
    try {
      this.bus?.publish(event);
    } catch {
      /* never let UI subscribers break control */
    }
  }

  // ---------------------------------------------------------------- commands

  /** Handle a command from the live view, tray, or global hotkey. */
  handleCommand(cmd: ControlSessionCommand): void {
    const s = this.sessions.get(cmd.sessionId);
    if (!s) return;
    switch (cmd.type) {
      case "pause":
        if (s.session.status !== "running") return;
        if (this.owner === cmd.sessionId) this.host.raiseStopFlag();
        this.update(cmd.sessionId, { status: "paused" });
        break;
      case "resume":
        if (s.session.status !== "paused") return;
        if (this.owner === cmd.sessionId) this.host.clearStopFlag();
        this.update(cmd.sessionId, { status: "running" });
        this.wake(cmd.sessionId);
        break;
      case "stop":
        if (this.owner === cmd.sessionId) this.host.raiseStopFlag();
        this.update(cmd.sessionId, { status: "stopped", currentAction: undefined });
        this.release(cmd.sessionId);
        this.wake(cmd.sessionId);
        break;
      case "takeControl":
        if (s.session.status === "stopped") return;
        if (this.owner === cmd.sessionId) this.host.raiseStopFlag();
        this.update(cmd.sessionId, { status: "user_controlling" });
        break;
      case "returnControl":
        if (s.session.status !== "user_controlling") return;
        if (this.owner === cmd.sessionId) this.host.clearStopFlag();
        this.resetBaseline();
        this.update(cmd.sessionId, { status: "running" });
        this.wake(cmd.sessionId);
        break;
    }
  }

  /** Emergency stop for every session (global hotkey / tray "Pause workers"). */
  stopAll(): void {
    this.host.raiseStopFlag();
    for (const id of this.sessions.keys()) this.handleCommand({ type: "stop", sessionId: id });
  }

  pauseAll(): void {
    for (const id of this.sessions.keys()) this.handleCommand({ type: "pause", sessionId: id });
  }

  resumeAll(): void {
    for (const id of this.sessions.keys()) this.handleCommand({ type: "resume", sessionId: id });
  }

  // ---------------------------------------------------------------- mutex

  private acquire(sessionId: ControlSessionId): Promise<void> {
    if (this.owner === sessionId) return Promise.resolve();
    if (this.owner === null) {
      this.grant(sessionId);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ sessionId, grant: resolve });
      this.update(sessionId, { currentAction: "Waiting for the computer" });
    });
  }

  private grant(sessionId: ControlSessionId): void {
    this.owner = sessionId;
    this.host.clearStopFlag();
    this.resetBaseline();
    this.startInputWatcher();
  }

  private release(sessionId: ControlSessionId): void {
    this.queue = this.queue.filter((q) => {
      if (q.sessionId !== sessionId) return true;
      q.grant(); // let it observe the stopped status and bail out
      return false;
    });
    if (this.owner !== sessionId) return;
    // Keep the stop flag up until the in-flight action has actually aborted.
    if (this.executing) {
      this.releaseAfterAction = true;
      return;
    }
    this.handOff();
  }

  private handOff(): void {
    this.owner = null;
    this.stopInputWatcher();
    const next = this.queue.shift();
    if (next) {
      this.grant(next.sessionId);
      next.grant();
    } else {
      this.host.clearStopFlag();
    }
  }

  /** Block while paused / user controlling; throw if stopped. */
  private async gate(sessionId: ControlSessionId, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const s = this.sessions.get(sessionId);
      if (!s) throw new ControlInterruptedError("stopped", "Control session no longer exists");
      if (signal?.aborted) throw new ControlInterruptedError("stopped", "Cancelled");
      const st = s.session.status;
      if (st === "running") return;
      if (st === "stopped") throw new ControlInterruptedError("stopped", "Stopped by user");
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
        s.waiters.push(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
  }

  // ---------------------------------------------------------------- execute

  /**
   * Run one ComputerAction for a session. Waits for the mouse/keyboard,
   * honors pause/stop/take-control, retries transient element lookups,
   * and returns an ActionResult the orchestrator can verify.
   */
  async execute(
    sessionId: ControlSessionId,
    action: HostComputerAction,
    opts: ExecuteOptions = {}
  ): Promise<ActionResult> {
    const actionId = `ca_${++actionSeq}_${Date.now().toString(36)}`;
    const started = Date.now();
    const isInput = INPUT_ACTIONS.has(action.type);
    const fail = (error: string, extra: Partial<ActionResult> = {}): ActionResult => ({
      actionId,
      ok: false,
      verified: false,
      retries: 0,
      error,
      durationMs: Date.now() - started,
      ...extra,
    });

    const needsMouse = isInput || action.type === "launch" || action.type === "close";
    try {
      if (needsMouse) await this.acquire(sessionId);
      await this.gate(sessionId, opts.signal);
    } catch (e) {
      const result = fail((e as Error).message, { output: { code: (e as ControlInterruptedError).code } });
      this.publish({ type: "control.action.result", sessionId, result });
      return result;
    }

    const summary = describeAction(action);
    this.update(sessionId, { currentAction: summary });
    this.publish({ type: "control.action", sessionId, actionId, summary, at: Date.now() });

    const onAbort = () => this.host.raiseStopFlag();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    this.executing = true;
    let result: ActionResult;
    try {
      let beforeRef: string | undefined;
      if (opts.captureBefore) beforeRef = (await this.screenshotFile())?.path;

      const maxRetries = opts.retries ?? 2;
      let res: HostResponse | undefined;
      let attempt = 0;
      for (; attempt <= maxRetries; attempt++) {
        res = await this.host.request({ id: nextRequestId("act"), method: "action", action }, opts.timeoutMs);
        if (res.ok || !res.code || !RETRYABLE.includes(res.code) || attempt === maxRetries) break;
        await sleep(300 * (attempt + 1));
        await this.gate(sessionId, opts.signal);
      }
      res = res!;

      if (!res.ok) {
        if (res.code === "user_input") {
          this.handleCommand({ type: "takeControl", sessionId });
        } else if (res.code === "stopped") {
          // status was already set by the command that raised the flag
        }
        result = fail(res.error, { retries: attempt, beforeScreenshotRef: beforeRef, output: { code: res.code } });
      } else {
        const out = (res.result ?? {}) as Record<string, unknown>;
        let afterRef: string | undefined;
        const wantAfter = opts.captureAfter ?? (isInput && action.type !== "move");
        if (wantAfter) {
          await sleep(this.o.settleMs);
          afterRef = (await this.screenshotFile())?.path;
        }
        result = {
          actionId,
          ok: true,
          verified: out.verified === true,
          retries: attempt,
          beforeScreenshotRef: beforeRef,
          afterScreenshotRef: afterRef,
          output: out,
          durationMs: Date.now() - started,
        };
      }
    } catch (e) {
      result = fail((e as Error).message, { output: { code: (e as ControlInterruptedError).code ?? "error" } });
    } finally {
      this.executing = false;
      opts.signal?.removeEventListener("abort", onAbort);
      if (this.releaseAfterAction) {
        this.releaseAfterAction = false;
        this.handOff();
      }
    }

    const cur = this.sessions.get(sessionId)?.session;
    if (cur && cur.status === "running") this.update(sessionId, { currentAction: undefined });
    this.publish({ type: "control.action.result", sessionId, result });
    return result;
  }

  /** Read-only host calls that don't need the mouse (windows, processes, UI tree). */
  async query(body: Record<string, unknown> & { method: string }, timeoutMs?: number): Promise<HostResponse> {
    return this.host.request({ id: nextRequestId(body.method), ...body } as never, timeoutMs);
  }

  async screenshotFile(opts: { region?: { x: number; y: number; w: number; h: number }; maxWidth?: number } = {}): Promise<ScreenshotResult | null> {
    const res = await this.host.request({ id: nextRequestId("shot"), method: "screenshot", format: "png", ...opts });
    return res.ok ? (res.result as ScreenshotResult) : null;
  }

  // ---------------------------------------------------------------- user input watcher

  private async resetBaseline(): Promise<void> {
    const res = await this.host.request({ id: nextRequestId("in"), method: "inputState" }, 5000);
    if (res.ok) this.baselineInputTick = (res.result as InputState).lastInputTick;
  }

  private startInputWatcher(): void {
    if (this.inputTimer) return;
    this.inputTimer = setInterval(() => void this.pollInput(), this.o.inputPollMs);
    this.inputTimer.unref?.();
  }

  private stopInputWatcher(): void {
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.inputTimer = null;
  }

  private polling = false;
  private async pollInput(): Promise<void> {
    // During an action the host itself detects user input; only watch between actions.
    if (this.polling || this.executing || !this.owner) return;
    const owner = this.sessions.get(this.owner)?.session;
    if (!owner || owner.status !== "running") return;
    this.polling = true;
    try {
      const res = await this.host.request({ id: nextRequestId("in"), method: "inputState" }, 3000);
      if (!res.ok) return;
      const st = res.result as InputState;
      const reference = Math.max(this.baselineInputTick, st.lastInjectTick);
      if (reference > 0 && st.lastInputTick - reference > this.o.userInputThresholdMs) {
        this.baselineInputTick = st.lastInputTick;
        if (this.owner && this.sessions.get(this.owner)?.session.status === "running") {
          this.handleCommand({ type: "takeControl", sessionId: this.owner });
        }
      }
    } finally {
      this.polling = false;
    }
  }

  // ---------------------------------------------------------------- live frames

  /** Call when the live view opens; returns an unsubscribe for when it closes. */
  watchFrames(): () => void {
    this.watchers++;
    if (!this.frameTimer) {
      const interval = Math.max(100, Math.round(1000 / this.o.frameFps));
      this.frameTimer = setInterval(() => void this.captureFrame(), interval);
      this.frameTimer.unref?.();
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.watchers = Math.max(0, this.watchers - 1);
      if (this.watchers === 0 && this.frameTimer) {
        clearInterval(this.frameTimer);
        this.frameTimer = null;
      }
    };
  }

  private async captureFrame(): Promise<void> {
    if (this.frameBusy || this.executing) return;
    const sessionId = this.owner ?? this.listSessions().find((s) => s.status !== "stopped")?.id;
    if (!sessionId) return;
    this.frameBusy = true;
    try {
      const res = await this.host.request(
        {
          id: nextRequestId("frame"),
          method: "screenshot",
          format: "jpeg",
          quality: 60,
          maxWidth: this.o.frameMaxWidth,
          inline: true,
        },
        5000
      );
      if (!res.ok) return;
      const r = res.result as ScreenshotResult;
      const cur = await this.host.request({ id: nextRequestId("cur"), method: "cursor" }, 2000);
      const frame: ControlFrame = {
        mimeType: "image/jpeg",
        width: r.width,
        height: r.height,
        scale: r.scale,
        origin: r.origin,
        dataUrl: r.base64 ? `data:image/jpeg;base64,${r.base64}` : undefined,
        cursor: cur.ok ? (cur.result as { x: number; y: number }) : undefined,
      };
      this.publish({ type: "control.frame", sessionId, frame, at: Date.now() });
    } finally {
      this.frameBusy = false;
    }
  }

  async dispose(): Promise<void> {
    this.stopInputWatcher();
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = null;
    for (const id of this.sessions.keys()) this.closeSession(id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
