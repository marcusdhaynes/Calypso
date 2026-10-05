/**
 * Headless integration smoke (no Electron):
 * - boot Orchestrator with temp DB
 * - create worker, persist, reload, confirm survival
 * - stream a reply through orchestrator conversation path with a mock provider
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);

// Prefer workspace package entrypoints (built dist).
const { Orchestrator } = await import(path.join(root, "packages/core/dist/index.js"));
const {
  DefaultModelRouter,
  buildCompletionRequest,
} = await import(path.join(root, "packages/models/dist/index.js"));
const { createSystemTools } = await import(path.join(root, "packages/tools-system/dist/index.js"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-desktop-int-"));
const dbPath = path.join(dir, "calypso.sqlite");

function mockProvider() {
  return {
    id: "mock",
    displayName: "Mock",
    async listModels() {
      return ["mock-model"];
    },
    async isReady() {
      return true;
    },
    async complete(request) {
      return {
        id: "cmpl_mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello from mock" },
            finish_reason: "stop",
          },
        ],
      };
    },
    async *stream(request) {
      const text = "Hello from mock stream";
      for (const ch of text.split(" ")) {
        yield {
          id: "chunk_mock",
          choices: [
            {
              index: 0,
              delta: { content: (ch === text.split(" ")[0] ? "" : " ") + ch },
              finish_reason: null,
            },
          ],
        };
      }
      yield {
        id: "chunk_mock_done",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
    },
  };
}

// ---- persistence round-trip ----
{
  const orch = new Orchestrator({ databasePath: dbPath, disableEmbeddings: true });
  for (const t of createSystemTools()) orch.registerTool(t);

  const worker = orch.createWorker({
    id: "w_int_1",
    name: "Integration",
    avatar: "int",
    role: "tester",
    personality: "precise",
    instructions: "Confirm persistence",
    skills: ["test"],
    tools: ["fs.read"],
    permissions: [],
    preferredModel: "normal",
    workspace: dir,
    autonomyLevel: "ask",
  });

  orch.database.upsertConversation({
    id: "c_int_1",
    title: "Integration",
    participantWorkerIds: [worker.id],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  orch.recordMessage({
    id: "m_int_1",
    conversationId: "c_int_1",
    author: { type: "user" },
    content: "ping",
    createdAt: Date.now(),
  });

  orch.close();

  const orch2 = new Orchestrator({ databasePath: dbPath, disableEmbeddings: true });
  const workers = orch2.workers.list();
  const convos = orch2.database.listConversations();
  const msgs = orch2.database.listMessages("c_int_1");
  const survived =
    workers.some((w) => w.id === "w_int_1" && w.name === "Integration") &&
    convos.some((c) => c.id === "c_int_1") &&
    msgs.some((m) => m.content === "ping");
  orch2.close();

  if (!survived) {
    console.error(JSON.stringify({ ok: false, stage: "persist", workers, convos, msgs }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, stage: "persist", workers: workers.length, msgs: msgs.length }));
}

// ---- mock stream through router + conversation ----
{
  const router = new DefaultModelRouter();
  const provider = mockProvider();
  router.registerProvider(provider);
  router.setRoute("normal", "mock", "mock-model");
  router.setRoute("simple", "mock", "mock-model");
  router.setRoute("code", "mock", "mock-model");
  router.setRoute("vision", "mock", "mock-model");
  router.setRoute("reasoning", "mock", "mock-model");
  router.setRoute("frontier", "mock", "mock-model");

  const orch = new Orchestrator({
    databasePath: path.join(dir, "stream.sqlite"),
    disableEmbeddings: true,
    modelRouter: router,
  });

  const worker = orch.createWorker({
    id: "w_stream",
    name: "Streamer",
    avatar: "s",
    role: "chat",
    personality: "brief",
    instructions: "Reply briefly",
    skills: [],
    tools: [],
    permissions: [],
    preferredModel: "normal",
    workspace: dir,
    autonomyLevel: "ask",
  });

  const { provider: p, model } = await router.resolve("normal", worker.preferredModel);
  const request = buildCompletionRequest(
    {
      model,
      messages: [
        { role: "system", content: "You are a test worker." },
        { role: "user", content: "hi" },
      ],
      stream: true,
    },
    "normal"
  );

  let full = "";
  for await (const chunk of p.stream(request)) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) full += delta;
  }

  const message = {
    id: "m_stream_1",
    conversationId: "c_stream",
    author: { type: "worker", workerId: worker.id },
    content: full,
    createdAt: Date.now(),
  };
  orch.database.upsertConversation({
    id: "c_stream",
    title: "Stream",
    participantWorkerIds: [worker.id],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  orch.recordMessage(message);
  const saved = orch.database.listMessages("c_stream");
  orch.close();

  const streamOk = full.includes("Hello") && saved.some((m) => m.content.includes("Hello"));
  if (!streamOk) {
    console.error(JSON.stringify({ ok: false, stage: "stream", full, saved }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, stage: "stream", full }));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, all: true }));
