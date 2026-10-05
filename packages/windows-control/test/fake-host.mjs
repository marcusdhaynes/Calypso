// Emulates calypso-host.ps1's line protocol for tests on non-Windows boxes.
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
const stopFlag = process.argv[2];
let notFoundLeft = 1;
let lastInput = 1000, lastInject = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ id: "_ready", ok: true, result: { ready: true } });
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const req = JSON.parse(line);
  const a = req.action ?? {};
  if (req.method === "ping") return out({ id: req.id, ok: true, result: { pong: true } });
  if (req.method === "inputState") return out({ id: req.id, ok: true, result: { lastInputTick: lastInput, lastInjectTick: lastInject, tickNow: 0 } });
  if (req.method === "cursor") return out({ id: req.id, ok: true, result: { x: 1, y: 2 } });
  if (req.method === "screenshot") return out({ id: req.id, ok: true, result: { width: 10, height: 10, scale: 1, format: req.format, origin: { x: 0, y: 0 }, sourceSize: { w: 10, h: 10 }, base64: req.inline ? "AAAA" : undefined, path: req.inline ? undefined : "/tmp/x.png" } });
  if (req.method === "simulateUserInput") { lastInput = lastInject + 5000; return out({ id: req.id, ok: true, result: {} }); }
  if (req.method === "action") {
    if (stopFlag && existsSync(stopFlag)) return out({ id: req.id, ok: false, error: "Stopped by user", code: "stopped" });
    if (a.type === "click" && a.locator?.name === "Flaky" && notFoundLeft-- > 0) return out({ id: req.id, ok: false, error: "nf", code: "not_found" });
    if (a.type === "type" && a.text === "interrupt") return out({ id: req.id, ok: false, error: "User took control", code: "user_input" });
    if (a.type === "hotkey" && a.keys?.[0] === "hang") return; // never answers
    if (a.type === "type" && a.text === "slow") { await new Promise((r) => setTimeout(r, 400)); if (existsSync(stopFlag)) return out({ id: req.id, ok: false, error: "Stopped by user", code: "stopped" }); }
    lastInject = lastInput = lastInput + 1;
    return out({ id: req.id, ok: true, result: { method: "uia_invoke", verified: a.type === "focusWindow" } });
  }
  out({ id: req.id, ok: false, error: "unknown", code: "error" });
});
