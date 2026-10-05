import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Orchestrator } from "../dist/index.js";
import { parseVerdict } from "../dist/runtime/step-checker.js";

function provider(script) {
  let i = 0;
  const next = () => script[i++] ?? { content: "done" };
  return {
    id: "fake", displayName: "Fake",
    async listModels() { return ["fake-model"]; },
    async isReady() { return true; },
    async complete() {
      const t = next();
      return { id: "c", choices: [{ index: 0, message: { role: "assistant", content: t.content ?? "" }, finish_reason: "stop" }] };
    },
    async *stream() {
      const t = next();
      yield { id: "s", choices: [{ index: 0, delta: { role: "assistant", content: t.content ?? "" }, finish_reason: "stop" }] };
    },
  };
}
const router = (p) => ({ async resolve() { return { provider: p, model: "fake-model" }; }, async listAvailable() { return []; } });
const wait = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("timeout");
};
const worker = (o) => ({ name: o.id, role: "generalist", personality: "", instructions: "", skills: [], tools: [], autonomy: "assisted", permissions: [], memoryScopes: [], ...o });

async function setup(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-pcr-"));
  const orch = new Orchestrator({ databasePath: path.join(dir, "t.sqlite"), disableEmbeddings: true, modelRouter: router(provider(script)), concurrency: 1, autoStartDispatcher: false });
  orch.dispatcher.start();
  const lead = orch.createWorker(worker({ id: "lead", role: "lead" }));
  const w = orch.createWorker(worker({ id: "w1", role: "writer" }));
  const team = orch.teams.upsert({ id: "t1", name: "T", description: "", memberIds: [lead.id, w.id], leadId: lead.id, createdAt: Date.now(), updatedAt: Date.now() });
  orch.database.upsertConversation({ id: "c1", title: "t", participantWorkerIds: [lead.id, w.id], teamId: team.id, createdAt: Date.now(), updatedAt: Date.now() });
  const res = await orch.handleUserMessage({ conversationId: "c1", content: "Write a list", teamId: team.id });
  return { orch, res };
}
const plan = JSON.stringify({ steps: [{ id: "a", title: "List", description: "Write 3 items", taskClass: "normal", dependsOnStepIds: [], suggestedRole: "writer", successCriteria: "exactly 3 items listed" }] });

test("failed check retries with feedback, then passes", async () => {
  const { orch, res } = await setup([
    { content: plan },
    { content: "1. apples" },
    { content: '{"ok":false,"reason":"Only 1 item."}' },
    { content: "1. apples 2. pears 3. plums" },
    { content: '{"ok":true,"reason":"3 items."}' },
  ]);
  const step = res.tasks.find((t) => t.parentId);
  assert.equal(step.successCriteria, "exactly 3 items listed");
  await wait(() => orch.tasks.get(res.task.id).status === "completed");
  const done = orch.tasks.get(step.id);
  assert.equal(done.status, "completed");
  assert.equal(done.checkAttempts, 1);
  assert.equal(done.checkFeedback, "Only 1 item.");
  assert.match(done.result, /plums/);
  orch.close?.();
});

test("step fails after 3 failed checks", async () => {
  const bad = '{"ok":false,"reason":"Still wrong."}';
  const { orch, res } = await setup([
    { content: plan }, { content: "x" }, { content: bad }, { content: "y" }, { content: bad }, { content: "z" }, { content: bad },
  ]);
  const step = res.tasks.find((t) => t.parentId);
  await wait(() => orch.tasks.get(step.id).status === "failed");
  const t = orch.tasks.get(step.id);
  assert.equal(t.checkAttempts, 3);
  assert.match(t.error, /after 3 attempts: Still wrong/);
  orch.close?.();
});

test("verdict parsing", () => {
  assert.deepEqual(parseVerdict('```json\n{"ok":false,"reason":"no"}\n```'), { ok: false, reason: "no" });
  assert.equal(parseVerdict("garbage").ok, true);
});
