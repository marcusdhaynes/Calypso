#!/usr/bin/env node
/**
 * Smoke for ensureInferenceRuntime / getInferenceRuntimeStatus.
 *
 * - Ollama down → expects state notInstalled|error, exit 0.
 * - Ollama up   → prints status. Pulls are SKIPPED by default
 *   (CALYPSO_SKIP_MODEL_PULL defaults to "1" here — this Linux box is low RAM).
 *   Set CALYPSO_SKIP_MODEL_PULL=0 on a real machine to actually pull.
 *
 * Run after `npm run build -w @calypso/models`.
 */
if (process.env.CALYPSO_SKIP_MODEL_PULL === undefined) {
  process.env.CALYPSO_SKIP_MODEL_PULL = "1";
}
const { ensureInferenceRuntime, getInferenceRuntimeStatus } = await import("../dist/index.js");

const events = [];
const bus = { publish: (e) => { events.push(e); console.log(`[event] ${e.type}`, JSON.stringify(e.progress ?? e.status)); } };

const status = await getInferenceRuntimeStatus();
console.log("[inference-runtime-smoke] status:", JSON.stringify(status, null, 2));

// Never auto-start a server from the smoke test.
const ensured = await ensureInferenceRuntime({ bus, autoStartServer: false });
console.log("[inference-runtime-smoke] ensure →", ensured.state, "-", ensured.message);

const fail = (msg) => { console.error(`[inference-runtime-smoke] FAIL: ${msg}`); process.exit(1); };
if (!events.some((e) => e.type === "models.runtime.progress")) fail("no models.runtime.progress events");
for (const e of events) {
  if (e.type === "models.runtime.progress" && (typeof e.progress?.phase !== "string" || typeof e.progress?.message !== "string")) {
    fail(`bad progress shape: ${JSON.stringify(e)}`);
  }
}
if (!status.ollamaReachable) {
  if (!["notInstalled", "error"].includes(ensured.state)) fail(`expected notInstalled|error, got ${ensured.state}`);
  console.log(`[inference-runtime-smoke] OK (Ollama down → ${ensured.state})`);
} else {
  if (ensured.state === "ready" && !events.some((e) => e.type === "models.runtime.ready")) fail("ready without models.runtime.ready event");
  console.log(`[inference-runtime-smoke] OK (Ollama up → ${ensured.state}; missing: ${ensured.missingModels.join(", ") || "none"})`);
}
process.exit(0);
