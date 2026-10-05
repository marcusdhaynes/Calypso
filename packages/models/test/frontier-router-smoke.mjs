#!/usr/bin/env node
/**
 * Smoke: DefaultModelRouter cloud frontier toggle.
 * - disabled → frontier falls back to local normal (qwen3:8b / mock)
 * - enabled + mock openai provider → frontier routes to cloud
 * - enabled without provider → falls back to local (no crash)
 *
 * Run after `npm run build -w @calypso/models`.
 */
import {
  DefaultModelRouter,
  DEFAULT_RTX_4060_8GB_ROUTES,
  toPublicSettings,
  createOpenAICloudProvider,
} from "../dist/index.js";

function mockProvider(id, model = "mock-model") {
  return {
    id,
    displayName: id,
    async listModels() {
      return [model];
    },
    async isReady() {
      return true;
    },
    async complete() {
      return {
        id: "c",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      };
    },
    async *stream() {
      yield { id: "s", choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] };
    },
  };
}

const fail = (msg) => {
  console.error(`[frontier-router-smoke] FAIL: ${msg}`);
  process.exit(1);
};

const notes = [];
const router = new DefaultModelRouter({
  cloudModelsEnabled: false,
  onFrontierFallback: (info) => notes.push(info),
});

router.registerProvider(mockProvider("ollama", "qwen3:8b"));
router.setRoute("normal", "ollama", "qwen3:8b");
router.setRoute("simple", "ollama", "qwen2.5:0.5b");
router.setRoute(
  "frontier",
  DEFAULT_RTX_4060_8GB_ROUTES.frontier.providerId,
  DEFAULT_RTX_4060_8GB_ROUTES.frontier.model
);

// 1) Disabled → local normal
{
  notes.length = 0;
  const r = await router.resolve("frontier");
  if (r.provider.id !== "ollama" || r.model !== "qwen3:8b") {
    fail(`disabled frontier expected ollama/qwen3:8b, got ${r.provider.id}/${r.model}`);
  }
  if (!notes.some((n) => n.reason === "cloud_disabled")) {
    fail("expected cloud_disabled fallback note");
  }
  console.log(JSON.stringify({ ok: true, stage: "disabled_fallback", model: r.model, notes: notes.length }));
}

// 2) Enabled + mock openai → cloud
{
  notes.length = 0;
  router.setCloudModelsEnabled(true);
  router.registerProvider(mockProvider("openai", "gpt-4o"));
  const r = await router.resolve("frontier");
  if (r.provider.id !== "openai" || r.model !== "gpt-4o") {
    fail(`enabled frontier expected openai/gpt-4o, got ${r.provider.id}/${r.model}`);
  }
  if (notes.length !== 0) fail("unexpected fallback notes when cloud ready");
  console.log(JSON.stringify({ ok: true, stage: "enabled_routes_cloud", model: r.model }));
}

// 3) Enabled, unregister openai → local fallback (no crash)
{
  notes.length = 0;
  router.unregisterProvider("openai");
  const r = await router.resolve("frontier");
  if (r.provider.id !== "ollama" || r.model !== "qwen3:8b") {
    fail(`missing key fallback expected ollama/qwen3:8b, got ${r.provider.id}/${r.model}`);
  }
  if (!notes.some((n) => n.reason === "no_api_key" || n.reason === "provider_missing")) {
    fail(`expected no_api_key/provider_missing note, got ${JSON.stringify(notes)}`);
  }
  console.log(JSON.stringify({ ok: true, stage: "enabled_no_provider_fallback", reason: notes[0]?.reason }));
}

// 4) preferredModel openai/… blocked when disabled
{
  notes.length = 0;
  router.setCloudModelsEnabled(false);
  router.registerProvider(mockProvider("openai", "gpt-4o"));
  const r = await router.resolve("normal", "openai/gpt-4o");
  if (r.provider.id !== "ollama") fail("preferred cloud path should fall back when disabled");
  console.log(JSON.stringify({ ok: true, stage: "preferred_cloud_blocked" }));
}

// 5) Settings helper syncs toggles; createOpenAICloudProvider null without key
{
  const { public: pub, stored } = toPublicSettings(null, {
    cloudModelsEnabled: true,
    frontier: { modelId: "gpt-4o-mini", baseUrl: "https://example.com/v1" },
  });
  if (!pub.cloudModelsEnabled || !pub.frontier.enabled) fail("toggles not synced");
  if (pub.frontier.modelId !== "gpt-4o-mini") fail("modelId not applied");
  if (stored.frontier?.apiKey) fail("must not invent apiKey");
  if (pub.hasCloudApiKey !== !!process.env.OPENAI_API_KEY && !process.env.CALYPSO_OPENAI_API_KEY) {
    // hasCloudApiKey depends on env; just ensure boolean
  }
  if (typeof pub.hasCloudApiKey !== "boolean") fail("hasCloudApiKey missing");

  const prev = process.env.OPENAI_API_KEY;
  const prev2 = process.env.CALYPSO_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CALYPSO_OPENAI_API_KEY;
  const none = createOpenAICloudProvider();
  if (none !== null) fail("createOpenAICloudProvider should return null without key");
  const withKey = createOpenAICloudProvider({ apiKey: "sk-test-not-logged" });
  if (!withKey || withKey.id !== "openai") fail("expected openai provider with explicit key");
  if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  if (prev2 !== undefined) process.env.CALYPSO_OPENAI_API_KEY = prev2;
  console.log(JSON.stringify({ ok: true, stage: "settings_and_factory", baseUrl: pub.frontier.baseUrl }));
}

// DEFAULT route table still points frontier at openai/gpt-4o
if (
  DEFAULT_RTX_4060_8GB_ROUTES.frontier.providerId !== "openai" ||
  DEFAULT_RTX_4060_8GB_ROUTES.frontier.model !== "gpt-4o"
) {
  fail("DEFAULT_RTX_4060_8GB_ROUTES.frontier must be openai/gpt-4o");
}

console.log("[frontier-router-smoke] OK");
process.exit(0);
