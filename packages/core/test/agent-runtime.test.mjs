import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Orchestrator } from "../dist/index.js";

/** Scripted ModelProvider — each complete/stream consumes the next scripted turn. */
function createFakeProvider(script) {
  let i = 0;
  const provider = {
    id: "fake",
    displayName: "Fake",
    async listModels() {
      return ["fake-model"];
    },
    async isReady() {
      return true;
    },
    async complete(request) {
      const turn = script[i++] ?? { content: "done" };
      if (turn.error) throw new Error(turn.error);
      return {
        id: `cmp_${i}`,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: turn.content ?? "",
              tool_calls: turn.tool_calls,
            },
            finish_reason: turn.tool_calls ? "tool_calls" : "stop",
          },
        ],
      };
    },
    async *stream(request, signal) {
      const turn = script[i++] ?? { content: "done" };
      if (turn.error) throw new Error(turn.error);
      if (signal?.aborted) throw new Error("aborted");
      if (turn.tool_calls) {
        for (const [idx, tc] of turn.tool_calls.entries()) {
          yield {
            id: `chk_${i}`,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: idx,
                      id: tc.id,
                      type: "function",
                      function: { name: tc.function.name, arguments: tc.function.arguments },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
        }
        yield {
          id: `chk_${i}_end`,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        };
        return;
      }
      const text = turn.content ?? "";
      // Stream in small chunks
      for (const part of text.match(/.{1,8}/g) ?? [""]) {
        if (signal?.aborted) throw new Error("aborted");
        yield {
          id: `chk_${i}`,
          choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
        };
      }
      yield {
        id: `chk_${i}_end`,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
    },
  };
  return provider;
}

function createFakeRouter(provider) {
  return {
    registerProvider() {},
    setRoute() {},
    async resolve() {
      return { provider, model: "fake-model" };
    },
  };
}

function waitFor(pred, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (pred()) return resolve();
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timeout"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function baseWorker(overrides = {}) {
  return {
    id: "w1",
    name: "Dev",
    avatar: "dev",
    role: "engineer",
    personality: "focused",
    instructions: "Ship it",
    skills: ["code"],
    tools: ["echo.ping", "team.message", "team.delegate"],
    permissions: [],
    preferredModel: "normal",
    workspace: "/tmp",
    autonomyLevel: "full",
    ...overrides,
  };
}

test("single-worker task with tool call through the gate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-rt-"));
  const dbPath = path.join(dir, "t.sqlite");

  const script = [
    {
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "echo.ping", arguments: JSON.stringify({ msg: "hi" }) },
        },
      ],
    },
    { content: "Tool said pong:hi" },
  ];
  const provider = createFakeProvider(script);
  const orch = new Orchestrator({
    databasePath: dbPath,
    disableEmbeddings: true,
    modelRouter: createFakeRouter(provider),
    autoStartDispatcher: false,
  });

  let gated = false;
  orch.registerTool({
    name: "echo.ping",
    description: "ping",
    toolClass: "read",
    parameters: { type: "object", properties: { msg: { type: "string" } } },
    async execute(params, ctx) {
      gated = true;
      // Gate already checked by executeToolCall; assert we got here.
      return {
        toolCallId: ctx.toolCallId,
        ok: true,
        output: { pong: params.msg },
        durationMs: 1,
      };
    },
  });

  const streams = [];
  orch.setStreamHandler((p) => streams.push(p));
  orch.dispatcher.start();

  const worker = orch.createWorker(baseWorker());
  orch.database.upsertConversation({
    id: "c1",
    title: "t",
    participantWorkerIds: [worker.id],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const { task } = await orch.handleUserMessage({
    conversationId: "c1",
    content: "Ping the echo tool",
    workerId: worker.id,
  });

  await waitFor(() => orch.tasks.get(task.id)?.status === "completed");
  const done = orch.tasks.get(task.id);
  assert.equal(done.status, "completed");
  assert.ok(gated, "tool should have executed through gate");
  assert.ok(streams.some((s) => s.done === true));
  const msgs = orch.database.listMessages("c1");
  assert.ok(msgs.some((m) => m.author.type === "worker" && m.content.includes("pong")));

  orch.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("team plan → parallel steps → parent completion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-rt-"));
  const dbPath = path.join(dir, "t.sqlite");

  const planJson = JSON.stringify({
    steps: [
      {
        id: "a",
        title: "Research",
        description: "Look things up",
        taskClass: "simple",
        dependsOnStepIds: [],
        suggestedRole: "researcher",
      },
      {
        id: "b",
        title: "Code",
        description: "Write code",
        taskClass: "code",
        dependsOnStepIds: [],
        suggestedRole: "engineer",
      },
    ],
  });

  // 1st call: planner complete(); then each worker streams a reply
  const script = [
    { content: planJson },
    { content: "Research done" },
    { content: "Code done" },
  ];
  // Planner uses complete(); workers use stream — fake provider shares one script index.
  // Override: make complete and stream share correctly (already same script array).

  const provider = createFakeProvider(script);
  const orch = new Orchestrator({
    databasePath: dbPath,
    disableEmbeddings: true,
    modelRouter: createFakeRouter(provider),
    concurrency: 2,
    autoStartDispatcher: false,
  });
  orch.dispatcher.start();

  const lead = orch.createWorker(
    baseWorker({ id: "lead", name: "Lead", role: "lead", skills: ["planning"], tools: [] })
  );
  const researcher = orch.createWorker(
    baseWorker({
      id: "res",
      name: "Res",
      role: "researcher",
      skills: ["research"],
      tools: [],
    })
  );
  const engineer = orch.createWorker(
    baseWorker({
      id: "eng",
      name: "Eng",
      role: "engineer",
      skills: ["code"],
      tools: [],
    })
  );

  const team = orch.teams.upsert({
    id: "team1",
    name: "Alpha",
    description: "test",
    memberIds: [lead.id, researcher.id, engineer.id],
    leadId: lead.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  orch.database.upsertConversation({
    id: "c2",
    title: "team",
    participantWorkerIds: [lead.id, researcher.id, engineer.id],
    teamId: team.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const { task, tasks } = await orch.handleUserMessage({
    conversationId: "c2",
    content: "Ship a feature",
    teamId: team.id,
  });

  assert.ok(tasks.length >= 3, "root + 2 steps");
  const rootId = task.id;

  await waitFor(() => orch.tasks.get(rootId)?.status === "completed", { timeoutMs: 8000 });

  const snap = orch.tasks.snapshot();
  const children = Object.values(snap.tasks).filter((t) => t.parentId === rootId);
  assert.equal(children.length, 2);
  assert.ok(children.every((c) => c.status === "completed"));
  assert.equal(snap.tasks[rootId].status, "completed");
  // Parallel: different assignees
  const assignees = new Set(children.map((c) => c.assignedWorkerId));
  assert.ok(assignees.has("res") || assignees.has("eng"));

  orch.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cancellation aborts a running task", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-rt-"));
  const dbPath = path.join(dir, "t.sqlite");

  // Slow stream: provider that waits until aborted
  const provider = {
    id: "fake",
    displayName: "Fake",
    async listModels() {
      return ["fake"];
    },
    async isReady() {
      return true;
    },
    async complete() {
      return { id: "x", choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }] };
    },
    async *stream(_req, signal) {
      yield {
        id: "1",
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      };
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 10_000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      });
      if (signal?.aborted) return;
    },
  };

  const orch = new Orchestrator({
    databasePath: dbPath,
    disableEmbeddings: true,
    modelRouter: createFakeRouter(provider),
    autoStartDispatcher: false,
  });
  orch.dispatcher.start();

  const worker = orch.createWorker(baseWorker({ tools: [] }));
  orch.database.upsertConversation({
    id: "c3",
    title: "c",
    participantWorkerIds: [worker.id],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const { task } = await orch.handleUserMessage({
    conversationId: "c3",
    content: "Long job",
    workerId: worker.id,
  });

  await waitFor(() => orch.tasks.get(task.id)?.status === "running");
  orch.cancelTask(task.id);
  await waitFor(() => orch.tasks.get(task.id)?.status === "cancelled");
  // Let the aborted agent loop finish its finally before closing the DB.
  await waitFor(() => orch.workers.get(worker.id)?.status === "idle");
  await new Promise((r) => setTimeout(r, 30));

  orch.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("retry requeues a failed task", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-rt-"));
  const dbPath = path.join(dir, "t.sqlite");

  let calls = 0;
  const provider = {
    id: "fake",
    displayName: "Fake",
    async listModels() {
      return ["fake"];
    },
    async isReady() {
      return true;
    },
    async complete() {
      return { id: "x", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
    },
    async *stream() {
      calls += 1;
      if (calls === 1) throw new Error("boom hard failure");
      yield {
        id: "1",
        choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: null }],
      };
      yield {
        id: "2",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
    },
  };

  const orch = new Orchestrator({
    databasePath: dbPath,
    disableEmbeddings: true,
    modelRouter: createFakeRouter(provider),
    autoStartDispatcher: false,
  });
  orch.dispatcher.start();

  const worker = orch.createWorker(baseWorker({ tools: [] }));
  orch.database.upsertConversation({
    id: "c4",
    title: "c",
    participantWorkerIds: [worker.id],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const { task } = await orch.handleUserMessage({
    conversationId: "c4",
    content: "May fail",
    workerId: worker.id,
  });

  await waitFor(() => orch.tasks.get(task.id)?.status === "failed");
  orch.retryTask(task.id);
  await waitFor(() => orch.tasks.get(task.id)?.status === "completed");
  assert.ok((orch.tasks.get(task.id).retryCount ?? 0) >= 1);
  assert.ok(orch.tasks.get(task.id).result?.includes("recovered"));

  orch.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("worker-to-worker message persistence + bus.chat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-rt-"));
  const dbPath = path.join(dir, "t.sqlite");
  const orch = new Orchestrator({
    databasePath: dbPath,
    disableEmbeddings: true,
    modelRouter: createFakeRouter(createFakeProvider([{ content: "hi" }])),
    autoStartDispatcher: false,
  });

  const a = orch.createWorker(baseWorker({ id: "a", name: "Alice", tools: ["team.message"] }));
  const b = orch.createWorker(baseWorker({ id: "b", name: "Bob", tools: [] }));
  orch.database.upsertConversation({
    id: "c5",
    title: "shared",
    participantWorkerIds: [a.id, b.id],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const events = [];
  orch.bus.subscribe((e) => events.push(e));

  const msg = orch.sendWorkerMessage(a.id, [b.id], "Need your help", {
    conversationId: "c5",
  });
  assert.ok(msg);
  assert.ok(msg.content.includes("Bob") || msg.content.includes("Need your help"));
  assert.ok(events.some((e) => e.type === "bus.chat" && e.fromWorkerId === "a"));

  const persisted = orch.database.listMessages("c5");
  assert.ok(persisted.some((m) => m.author.type === "worker" && m.author.workerId === "a"));

  orch.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("restart persistence keeps workers/tasks/messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-rt-"));
  const dbPath = path.join(dir, "t.sqlite");

  const orch = new Orchestrator({
    databasePath: dbPath,
    disableEmbeddings: true,
    modelRouter: createFakeRouter(createFakeProvider([{ content: "persisted reply" }])),
    autoStartDispatcher: false,
  });
  orch.dispatcher.start();

  const worker = orch.createWorker(baseWorker({ tools: [] }));
  orch.database.upsertConversation({
    id: "c6",
    title: "c",
    participantWorkerIds: [worker.id],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const { task } = await orch.handleUserMessage({
    conversationId: "c6",
    content: "Remember this",
    workerId: worker.id,
  });
  await waitFor(() => orch.tasks.get(task.id)?.status === "completed");
  orch.close();

  const orch2 = new Orchestrator({
    databasePath: dbPath,
    disableEmbeddings: true,
    autoStartDispatcher: false,
  });
  assert.ok(orch2.workers.get(worker.id));
  assert.equal(orch2.tasks.get(task.id)?.status, "completed");
  const msgs = orch2.database.listMessages("c6");
  assert.ok(msgs.length >= 2);
  orch2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("routines fire into the dispatcher", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-rt-"));
  const dbPath = path.join(dir, "t.sqlite");
  const provider = createFakeProvider([{ content: "routine done" }]);
  const orch = new Orchestrator({
    databasePath: dbPath,
    disableEmbeddings: true,
    modelRouter: createFakeRouter(provider),
    autoStartDispatcher: false,
  });
  orch.dispatcher.start();

  const worker = orch.createWorker(baseWorker({ tools: [] }));
  orch.scheduler.upsert({
    id: "r1",
    name: "tick",
    description: "fire once",
    schedule: { type: "once", at: Date.now() - 1000 },
    workerId: worker.id,
    taskTemplate: { title: "Routine task", description: "from routine", taskClass: "simple" },
    enabled: true,
    nextRunAt: Date.now() - 1000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const fired = orch.scheduler.tick(Date.now());
  assert.equal(fired.length, 1);

  await waitFor(() => {
    const tasks = Object.values(orch.tasks.snapshot().tasks);
    return tasks.some((t) => t.title === "Routine task" && t.status === "completed");
  });

  orch.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
