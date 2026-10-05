/**
 * Wire protocol between Node and the long-lived PowerShell host
 * (`host/calypso-host.ps1`). One JSON object per line in each direction.
 */
import type { ComputerAction, UiaLocator } from "@calypso/shared";

/** Extra knobs the host understands on top of the shared ComputerAction. */
export interface HostActionOptions {
  /** click: skip UIA Invoke/Toggle/Select and use the real mouse. */
  forceMouse?: boolean;
  /** type: skip ValuePattern and send real keystrokes. */
  forceKeys?: boolean;
  /** type with ValuePattern: append instead of replace. */
  append?: boolean;
  /** close: kill the process if it doesn't exit gracefully (destructive). */
  force?: boolean;
  /** launch/close: how long to wait for a window / exit. */
  waitMs?: number;
  /** launch: working directory. */
  cwd?: string;
  /** readUiTree: node cap. */
  maxNodes?: number;
  /** screenshot options */
  format?: "png" | "jpeg";
  quality?: number;
  scale?: number;
  maxWidth?: number;
  inline?: boolean;
  drawCursor?: boolean;
}

export type HostComputerAction = ComputerAction & HostActionOptions;

export interface ScreenshotOptions {
  region?: { x: number; y: number; w: number; h: number };
  format?: "png" | "jpeg";
  quality?: number;
  scale?: number;
  maxWidth?: number;
  /** Return base64 instead of writing a file. */
  inline?: boolean;
  drawCursor?: boolean;
}

export type HostRequest =
  | { id: string; method: "ping" }
  | { id: string; method: "action"; action: HostComputerAction | ComputerAction }
  | ({ id: string; method: "screenshot" } & ScreenshotOptions)
  | { id: string; method: "listWindows" }
  | { id: string; method: "listProcesses"; withWindowsOnly?: boolean }
  | { id: string; method: "inputState" }
  | { id: string; method: "screenInfo" }
  | { id: string; method: "cursor" }
  | { id: string; method: "findElement"; locator: UiaLocator }
  | { id: string; method: "shutdown" };

/** Distributes Omit over a union so each request variant keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type HostRequestBody = DistributiveOmit<HostRequest, "id">;

/**
 * Error codes the host returns:
 * - user_input: real mouse/keyboard input interrupted an agent action
 * - stopped: the stop flag was set (Pause / Stop / Take Control)
 * - not_found / not_clickable: UI element couldn't be resolved
 * - timeout / host_crashed / host_unavailable: Node-side transport failures
 * - error: anything else
 */
export type HostErrorCode =
  | "user_input"
  | "stopped"
  | "not_found"
  | "not_clickable"
  | "timeout"
  | "host_crashed"
  | "host_unavailable"
  | "error";

export type HostResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string; code?: HostErrorCode };

/**
 * What the host saw after an input action (Trice). Every input action result
 * carries one:
 * - passed: the intended effect was observed (verified = true)
 * - failed: the host saw that nothing happened; the controller retries once
 *   when retrySafe, then returns ok=false with code verify_failed
 * - unknown: the host couldn't tell; the worker should look at the screen
 */
export interface ActionVerification {
  status: "passed" | "failed" | "unknown";
  checks: string[];
  changed: string[];
  note: string;
  retrySafe: boolean;
}

export function verificationOf(result: unknown): ActionVerification | undefined {
  const v = (result as { verification?: ActionVerification } | null | undefined)?.verification;
  return v && typeof v === "object" && typeof v.status === "string" ? v : undefined;
}

export interface ScreenshotResult {
  width: number;
  height: number;
  scale: number;
  format: "png" | "jpeg";
  origin: { x: number; y: number };
  sourceSize: { w: number; h: number };
  path?: string;
  base64?: string;
}

export interface InputState {
  lastInputTick: number;
  lastInjectTick: number;
  tickNow: number;
}
