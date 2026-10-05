import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "../dist/index.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-core-"));
const dbPath = path.join(dir, "test.sqlite");

const orch = new Orchestrator({ databasePath: dbPath, disableEmbeddings: true });

const worker = orch.createWorker({
  id: "w1",
  name: "Dev",
  avatar: "dev",
  role: "engineer",
  personality: "focused",
  instructions: "Ship it",
  skills: ["code"],
  tools: [],
  permissions: [],
  preferredModel: "code",
  workspace: dir,
  autonomyLevel: "ask",
});

const task = orch.createTask({
  id: "t1",
  title: "Persist me",
  description: "roundtrip",
  status: "pending",
  parentId: null,
  dependsOn: [],
  assignedWorkerId: worker.id,
  taskClass: "simple",
});

await orch.memory.write({
  kind: "fact",
  content: "Marcus prefers dark mode",
  facts: { theme: "dark" },
  scope: { type: "user" },
});

const retrieved = await orch.memory.retrieve({ text: "dark mode", scope: { type: "user" }, limit: 5 });
orch.close();

const orch2 = new Orchestrator({ databasePath: dbPath, disableEmbeddings: true });
const workers = orch2.workers.list();
const tasks = orch2.tasks.snapshot();
const mem = await orch2.memory.retrieve({ scope: { type: "user" }, limit: 5 });
orch2.close();

const ok =
  workers.some((w) => w.id === "w1") &&
  !!tasks.tasks["t1"] &&
  mem.some((m) => m.content.includes("dark mode")) &&
  retrieved.length >= 1;

console.log(JSON.stringify({ ok, workers: workers.length, tasks: Object.keys(tasks.tasks).length, mem: mem.length, retrieved: retrieved.length, dbPath }, null, 2));
if (!ok) process.exit(1);
fs.rmSync(dir, { recursive: true, force: true });
