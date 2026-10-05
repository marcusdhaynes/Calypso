import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "../dist/index.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "calypso-art-"));
const dbPath = path.join(root, "calypso.sqlite");

const orch = new Orchestrator({
  databasePath: dbPath,
  userDataRoot: root,
  disableEmbeddings: true,
  autoStartDispatcher: false,
});

const worker = orch.createWorker({
  id: "w1",
  name: "Tester",
  avatar: "t",
  role: "assistant",
  personality: "curious",
  instructions: "capture",
  skills: [],
  tools: [],
  permissions: [],
  preferredModel: "simple",
  workspace: root,
  autonomyLevel: "trusted",
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const shot = orch.artifacts.captureFromTool(
  worker,
  { id: "tc1", toolName: "browser.snapshot", toolClass: "browser", params: {}, workerId: worker.id, status: "completed", createdAt: Date.now() },
  {
    toolCallId: "tc1",
    ok: true,
    output: { base64: png.toString("base64"), mimeType: "image/png", byteLength: png.length },
    durationMs: 1,
  },
);
assert.ok(shot);
assert.equal(shot.kind, "image");
assert.ok(fs.existsSync(shot.uri));

const extract = orch.artifacts.captureFromTool(
  worker,
  { id: "tc2", toolName: "browser.extract", toolClass: "browser", params: {}, workerId: worker.id, status: "completed", createdAt: Date.now() },
  {
    toolCallId: "tc2",
    ok: true,
    output: { text: "Hello from extract", title: "Example" },
    durationMs: 1,
  },
);
assert.ok(extract);
assert.equal(extract.kind, "document");
assert.equal(extract.title, "Example");

const filePath = path.join(root, "dl.bin");
fs.writeFileSync(filePath, "x");
const fileArt = orch.artifacts.captureFromTool(
  worker,
  { id: "tc3", toolName: "browser.download", toolClass: "browser_download", params: {}, workerId: worker.id, status: "completed", createdAt: Date.now() },
  {
    toolCallId: "tc3",
    ok: true,
    output: { path: filePath, suggestedFilename: "dl.bin" },
    durationMs: 1,
  },
);
assert.ok(fileArt);
assert.equal(fileArt.kind, "file");
assert.equal(orch.listArtifacts().length, 3);

orch.close();

const orch2 = new Orchestrator({
  databasePath: dbPath,
  userDataRoot: root,
  disableEmbeddings: true,
  autoStartDispatcher: false,
});
assert.equal(orch2.listArtifacts().length, 3);
assert.equal(orch2.deleteArtifact(shot.id), true);
assert.equal(orch2.listArtifacts().length, 2);
orch2.close();

console.log(JSON.stringify({ ok: true, root }, null, 2));
fs.rmSync(root, { recursive: true, force: true });
