/**
 * Scaffolding smoke: empty body fails navigate verify; empty extract fails + retries;
 * real page extract passes.
 * Run: node packages/browser/test/verify-smoke.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = pathToFileURL(join(here, "..", "dist", "index.js")).href;

const { BrowserSessionManager, runBrowserAction } = await import(dist);

const dataRoot = mkdtempSync(join(tmpdir(), "calypso-browser-verify-"));
const manager = new BrowserSessionManager({ dataRoot, headless: true });

const emptyHtml =
  "data:text/html," +
  encodeURIComponent("<!doctype html><html><body>   \n\t  </body></html>");

try {
  const session = await manager.openSession({ workerId: "worker-verify" });

  const emptyNav = await runBrowserAction(manager, {
    sessionId: session.id,
    action: { type: "navigate", url: emptyHtml },
    maxRetries: 0,
  });
  console.log("empty-nav", {
    ok: emptyNav.ok,
    verified: emptyNav.verified,
    error: emptyNav.error,
    output: emptyNav.output,
  });
  if (emptyNav.verified) throw new Error("expected empty body navigate to fail verify");

  const good = await runBrowserAction(manager, {
    sessionId: session.id,
    action: { type: "navigate", url: "https://example.com/" },
  });
  console.log("good-nav", { ok: good.ok, verified: good.verified, error: good.error });
  if (!good.ok || !good.verified) throw new Error(`good navigate failed: ${good.error}`);

  const extract = await runBrowserAction(manager, {
    sessionId: session.id,
    action: { type: "extract" },
  });
  console.log("extract", {
    ok: extract.ok,
    verified: extract.verified,
    retries: extract.retries,
    title: extract.output?.title,
  });
  if (!extract.ok || !extract.verified) throw new Error(`extract failed: ${extract.error}`);
  if (!isNonEmpty(String(extract.output?.text ?? ""))) throw new Error("extract text empty");

  // Fresh session so example.com origin pin does not block data: URLs
  const emptySession = await manager.openSession({
    workerId: "worker-verify-empty",
    sessionId: "worker-verify-empty",
  });
  const emptyNav2 = await runBrowserAction(manager, {
    sessionId: emptySession.id,
    action: { type: "navigate", url: emptyHtml },
    maxRetries: 0,
  });
  if (emptyNav2.verified) throw new Error("empty session navigate should fail verify");

  const emptyExtract = await runBrowserAction(manager, {
    sessionId: emptySession.id,
    action: { type: "extract" },
    maxRetries: 1,
  });
  console.log("empty-extract", {
    ok: emptyExtract.ok,
    verified: emptyExtract.verified,
    retries: emptyExtract.retries,
    error: emptyExtract.error,
  });
  if (emptyExtract.verified) throw new Error("expected empty extract to fail verify");
  if ((emptyExtract.retries ?? 0) < 1) {
    throw new Error("expected at least one retry on empty extract");
  }

  console.log("VERIFY_SMOKE_OK");
} finally {
  await manager.dispose();
  rmSync(dataRoot, { recursive: true, force: true });
}

function isNonEmpty(t) {
  return t.replace(/\s+/g, " ").trim().length >= 1;
}
