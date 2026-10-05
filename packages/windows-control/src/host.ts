/**
 * Long-lived PowerShell host client.
 * Core talks to a Windows-side host over stdin/stdout JSON lines.
 * Trice owns the host binary / script; this is the Node-side bridge stub.
 */
export type HostRequest =
  | { id: string; method: "ping" }
  | { id: string; method: "action"; action: unknown }
  | { id: string; method: "screenshot"; region?: unknown };

export type HostResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export interface PowerShellHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  request(req: HostRequest): Promise<HostResponse>;
  get running(): boolean;
}

/** Stub host — real spawn of powershell.exe + JSON protocol is Trice's work. */
export class StubPowerShellHost implements PowerShellHost {
  private _running = false;

  get running(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    this._running = true;
  }

  async stop(): Promise<void> {
    this._running = false;
  }

  async request(req: HostRequest): Promise<HostResponse> {
    if (!this._running) {
      return { id: req.id, ok: false, error: "PowerShell host not running" };
    }
    return {
      id: req.id,
      ok: false,
      error: "StubPowerShellHost — implement stdin/stdout JSON protocol (Trice)",
    };
  }
}
