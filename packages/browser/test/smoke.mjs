/**
 * Smoke: open session → navigate → extract → click → screenshot → close.
 * Run from repo root: node packages/browser/test/smoke.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = pathToFileURL(join(here, "..", "dist", "index.js")).href;

const { BrowserSessionManager, runBrowserAction } = await import(dist);

const dataRoot = mkdtempSync(join(tmpdir(), "calypso-browser-"));
const manager = new BrowserSessionManager({ dataRoot, headless: true });

try {
  const session = await manager.openSession({ workerId: "worker-smoke" });
  console.log("session", session.id);

  const nav = await runBrowserAction(manager, {
    sessionId: session.id,
    action: { type: "navigate", url: "https://example.com/" },
  });
  console.log("navigate", {
    ok: nav.ok,
    verified: nav.verified,
    error: nav.error,
    output: nav.output,
  });
  if (!nav.ok || !nav.verified) throw new Error(`navigate failed: ${nav.error}`);

  const extract = await runBrowserAction(manager, {
    sessionId: session.id,
    action: { type: "extract" },
  });
  console.log("extract", {
    ok: extract.ok,
    verified: extract.verified,
    error: extract.error,
    title: extract.output?.title,
    textPreview: String(extract.output?.text ?? "").slice(0, 80),
  });
  if (!extract.ok) throw new Error(`extract failed: ${extract.error}`);
  if (!/Example Domain/i.test(String(extract.output?.title ?? extract.output?.text ?? ""))) {
    throw new Error("unexpected page content");
  }

  const shot = await runBrowserAction(manager, {
    sessionId: session.id,
    action: { type: "screenshot" },
  });
  const bytes = shot.output?.byteLength ?? 0;
  console.log("screenshot", { ok: shot.ok, byteLength: bytes, error: shot.error });
  if (!shot.ok || bytes < 1000) throw new Error(`screenshot failed: ${shot.error}`);

  const tab = await runBrowserAction(manager, {
    sessionId: session.id,
    action: { type: "newTab", url: "https://example.com/" },
  });
  console.log("newTab", { ok: tab.ok, output: tab.output });
  if (!tab.ok) throw new Error(`newTab failed: ${tab.error}`);

  console.log("SMOKE_OK");
} finally {
  await manager.dispose();
  rmSync(dataRoot, { recursive: true, force: true });
}
