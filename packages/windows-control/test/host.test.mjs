import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ProcessPowerShellHost, ComputerController, createWindowsControl } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
function makeHost(extra = {}) {
  const h = new ProcessPowerShellHost({ command: process.execPath, args: [], autoRestart: true, requestTimeoutMs: 1500, ...extra });
  h.opts.args = [join(here, "fake-host.mjs"), h.stopFlagPath];
  return h;
}
function bus() { const events = []; return { events, publish: (e) => events.push(e) }; }

test("host request/response and restart after timeout", async () => {
  const h = makeHost();
  await h.start();
  const r = await h.request({ id: "a", method: "ping" });
  assert.equal(r.ok, true);
  const t = await h.request({ id: "b", method: "action", action: { type: "hotkey", keys: ["hang"] } }, 300);
  assert.equal(t.ok, false); assert.equal(t.code, "timeout");
  await new Promise((r) => setTimeout(r, 500));
  const r2 = await h.request({ id: "c", method: "ping" });
  assert.equal(r2.ok, true, "host restarted");
  await h.stop();
});

test("controller: execute, retries, events, after-screenshot", async () => {
  const h = makeHost(); const b = bus();
  const c = new ComputerController(h, b, { settleMs: 1 });
  const s = c.openSession({ workerId: "w1", objective: "Test" });
  const res = await c.execute(s.id, { type: "click", locator: { kind: "name", name: "Flaky" } });
  assert.equal(res.ok, true); assert.equal(res.retries, 1); assert.equal(res.afterScreenshotRef, "/tmp/x.png");
  assert.ok(b.events.some((e) => e.type === "control.action" && e.summary === 'Click "Flaky"'));
  assert.ok(b.events.some((e) => e.type === "control.action.result"));
  const f = await c.execute(s.id, { type: "focusWindow", title: "Notepad" }, { captureAfter: false });
  assert.equal(f.verified, true);
  await c.dispose(); await h.stop();
});

test("controller: verification retries once when safe, then fails clearly", async () => {
  const h = makeHost(); const b = bus();
  const c = new ComputerController(h, b, { settleMs: 1 });
  const s = c.openSession({ workerId: "w1", objective: "Verify" });
  const lost = await c.execute(s.id, { type: "type", text: "lost", locator: { kind: "name", name: "Search" } }, { captureAfter: false });
  assert.equal(lost.ok, true); assert.equal(lost.verified, true); assert.equal(lost.retries, 1);
  const never = await c.execute(s.id, { type: "type", text: "never", locator: { kind: "name", name: "Search" } }, { captureAfter: false });
  assert.equal(never.ok, false); assert.equal(never.retries, 1); assert.equal(never.output.code, "verify_failed");
  assert.match(never.error, /didn't take effect \(tried 2 times\): the field's text didn't change/);
  const rc = await c.execute(s.id, { type: "rightClick", locator: { kind: "coords", x: 5, y: 5 } }, { captureAfter: false });
  assert.equal(rc.ok, false); assert.equal(rc.retries, 0, "not retried when unsafe");
  const hk = await c.execute(s.id, { type: "hotkey", keys: ["ctrl", "c"] }, { captureAfter: false });
  assert.equal(hk.ok, true); assert.equal(hk.verified, false); assert.equal(hk.output.verification.status, "unknown");
  await c.dispose(); await h.stop();
});

test("controller: user input mid-action hands control to the user, returnControl resumes", async () => {
  const h = makeHost(); const b = bus();
  const c = new ComputerController(h, b, { settleMs: 1 });
  const s = c.openSession({ workerId: "w1", objective: "Test" });
  const r = await c.execute(s.id, { type: "type", text: "interrupt" });
  assert.equal(r.ok, false); assert.equal(r.output.code, "user_input");
  assert.equal(c.getSession(s.id).status, "user_controlling");
  const pending = c.execute(s.id, { type: "type", text: "after" }, { captureAfter: false });
  await new Promise((r) => setTimeout(r, 100));
  c.handleCommand({ type: "returnControl", sessionId: s.id });
  const r2 = await pending;
  assert.equal(r2.ok, true);
  await c.dispose(); await h.stop();
});

test("controller: stop aborts the in-flight action and later ones", async () => {
  const h = makeHost(); const b = bus();
  const c = new ComputerController(h, b, { settleMs: 1 });
  const s = c.openSession({ workerId: "w1", objective: "Test" });
  const p = c.execute(s.id, { type: "type", text: "slow" });
  await new Promise((r) => setTimeout(r, 100));
  c.handleCommand({ type: "stop", sessionId: s.id });
  const r = await p;
  assert.equal(r.ok, false); assert.equal(r.output.code, "stopped");
  const r2 = await c.execute(s.id, { type: "type", text: "x" });
  assert.equal(r2.ok, false);
  assert.equal(c.getSession(s.id).status, "stopped");
  await c.dispose(); await h.stop();
});

test("controller: user input between actions triggers take control", async () => {
  const h = makeHost(); const b = bus();
  const c = new ComputerController(h, b, { settleMs: 1, inputPollMs: 50, userInputThresholdMs: 100 });
  const s = c.openSession({ workerId: "w1", objective: "Test" });
  await c.execute(s.id, { type: "type", text: "hello" }, { captureAfter: false });
  await h.request({ id: "sim", method: "simulateUserInput" });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(c.getSession(s.id).status, "user_controlling");
  await c.dispose(); await h.stop();
});

test("controller: two workers share the mouse in FIFO order", async () => {
  const h = makeHost(); const b = bus();
  const c = new ComputerController(h, b, { settleMs: 1 });
  const s1 = c.openSession({ workerId: "w1", objective: "A" });
  const s2 = c.openSession({ workerId: "w2", objective: "B" });
  const order = [];
  const p1 = c.execute(s1.id, { type: "type", text: "one" }, { captureAfter: false }).then(() => order.push(1));
  const p2 = c.execute(s2.id, { type: "type", text: "two" }, { captureAfter: false }).then(() => order.push(2));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(order, [1]);
  c.closeSession(s1.id);
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
  await c.dispose(); await h.stop();
});

test("frames stream as control.frame while watched", async () => {
  const h = makeHost(); const b = bus();
  const c = new ComputerController(h, b, { frameFps: 20 });
  c.openSession({ workerId: "w1", objective: "Watch" });
  const stop = c.watchFrames();
  await new Promise((r) => setTimeout(r, 400));
  stop();
  const frames = b.events.filter((e) => e.type === "control.frame");
  assert.ok(frames.length >= 2);
  assert.equal(frames[0].frame.dataUrl, "data:image/jpeg;base64,AAAA");
  assert.deepEqual(frames[0].frame.cursor, { x: 1, y: 2 });
  await c.dispose(); await h.stop();
});

test("tools respect the permission gate", async () => {
  const h = makeHost();
  const wc = createWindowsControl({ host: h, controller: { settleMs: 1 } });
  const tool = wc.tools.find((t) => t.name === "windows.close_app");
  const seen = [];
  const ctx = (decision) => ({
    toolCallId: "tc", workerId: "w1", worker: { id: "w1", autonomyLevel: "ask", workspace: "" },
    gate: { check: async (_w, call) => { seen.push(call.toolClass); return decision; }, resolve() {} },
    onProgress() {},
  });
  const denied = await tool.execute({ processId: 1, force: true }, ctx({ decision: "deny", reason: "nope" }));
  assert.equal(denied.ok, false); assert.equal(denied.error, "nope");
  assert.deepEqual(seen, ["destructive"]);
  assert.deepEqual(wc.tools.map((t) => [t.name, t.toolClass]), [
    ["windows.computer", "input_control"], ["windows.observe", "read"], ["windows.launch_app", "process"],
    ["windows.close_app", "process"], ["windows.powershell", "process"],
  ]);
  await wc.dispose();
});

test("powershell tool runs a real command (pwsh)", { skip: !process.env.PWSH_TEST }, async () => {
  const { runPowerShell } = await import("../dist/index.js");
  const r = await runPowerShell("Write-Output ('hi ' + (1+1)); exit 3", { exe: process.env.PWSH_TEST });
  assert.equal(r.stdout.trim(), "hi 2"); assert.equal(r.exitCode, 3);
});
