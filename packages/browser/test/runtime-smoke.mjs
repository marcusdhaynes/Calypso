/**
 * Smoke: ensureChromium into a temp PLAYWRIGHT_BROWSERS_PATH (reuses cache if copied).
 * Prefer pointing at existing cache via CALYPSO_TEST_BROWSERS_PATH to avoid re-download.
 * Run: node packages/browser/test/runtime-smoke.mjs
 */
import { mkdtempSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = pathToFileURL(
  join(new URL("..", import.meta.url).pathname, "dist", "index.js"),
).href;
const { ensureChromium, getBrowserRuntimeStatus } = await import(dist);

const defaultCache = join(homedir(), ".cache", "ms-playwright");
const browsersPath =
  process.env.CALYPSO_TEST_BROWSERS_PATH ??
  mkdtempSync(join(tmpdir(), "calypso-ms-playwright-"));

const createdTemp = !process.env.CALYPSO_TEST_BROWSERS_PATH;

try {
  // If temp and default cache exists, copy chromium folder to avoid network in CI.
  if (createdTemp && existsSync(defaultCache)) {
    console.log("seeding from", defaultCache);
    cpSync(defaultCache, browsersPath, { recursive: true });
  }

  const events = [];
  const status = await ensureChromium({
    browsersPath,
    onProgress: (p) => {
      events.push(p);
      console.log("progress", p.phase, p.percent ?? "", p.message);
    },
  });
  console.log("status", status);
  if (!status.installed) throw new Error("not installed");
  const again = await getBrowserRuntimeStatus(browsersPath);
  if (!again.installed) throw new Error("status check failed");
  if (!events.some((e) => e.phase === "ready")) throw new Error("no ready event");
  console.log("RUNTIME_SMOKE_OK");
} finally {
  if (createdTemp) {
    rmSync(browsersPath, { recursive: true, force: true });
  }
}
