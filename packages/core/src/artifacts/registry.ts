import fs from "node:fs";
import path from "node:path";
import type {
  Artifact,
  ArtifactId,
  ArtifactKind,
  EventBus,
  MessageAuthor,
  ProjectId,
  TaskId,
  ToolCall,
  ToolResult,
  Worker,
} from "@calypso/shared";
import type { CalypsoDatabase } from "../db/database.js";
import { newId } from "../runtime/ids.js";

export interface ArtifactRegistryOptions {
  database?: CalypsoDatabase;
  /** Directory for screenshot/extract/file payloads on disk. */
  artifactsRoot: string;
  bus: EventBus;
}

/**
 * Persists chat/tool outputs that should appear in the Artifacts panel
 * (screenshots, extracts, downloads, misc files).
 */
export class ArtifactRegistry {
  private items = new Map<ArtifactId, Artifact>();
  private readonly database?: CalypsoDatabase;
  private readonly artifactsRoot: string;
  private readonly bus: EventBus;

  constructor(opts: ArtifactRegistryOptions) {
    this.database = opts.database;
    this.artifactsRoot = opts.artifactsRoot;
    this.bus = opts.bus;
    fs.mkdirSync(this.artifactsRoot, { recursive: true });
    if (this.database) {
      for (const a of this.database.listArtifacts()) this.items.set(a.id, a);
    }
  }

  list(): Artifact[] {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: ArtifactId): Artifact | undefined {
    return this.items.get(id);
  }

  delete(id: ArtifactId): boolean {
    const ok = this.items.delete(id);
    if (ok) this.database?.deleteArtifact(id);
    return ok;
  }

  upsert(artifact: Artifact): Artifact {
    this.items.set(artifact.id, artifact);
    this.database?.upsertArtifact(artifact);
    this.bus.publish({ type: "artifact.created", artifact });
    return artifact;
  }

  create(input: {
    id?: ArtifactId;
    kind: ArtifactKind;
    title: string;
    uri: string;
    mimeType?: string;
    projectId?: ProjectId;
    taskId?: TaskId;
    createdBy: MessageAuthor;
    metadata?: Record<string, unknown>;
  }): Artifact {
    const now = Date.now();
    const artifact: Artifact = {
      id: input.id ?? newId("art"),
      kind: input.kind,
      title: input.title,
      uri: input.uri,
      mimeType: input.mimeType,
      projectId: input.projectId,
      taskId: input.taskId,
      createdBy: input.createdBy,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    return this.upsert(artifact);
  }

  /**
   * Turn successful browser tool results into panel artifacts.
   * Screenshots → image files under artifactsRoot; extracts → .txt; downloads → file uri.
   */
  captureFromTool(
    worker: Worker,
    toolCall: ToolCall,
    result: ToolResult,
  ): Artifact | undefined {
    if (!result.ok || result.output == null) return undefined;

    const createdBy: MessageAuthor = { type: "worker", workerId: worker.id };
    const taskId = toolCall.taskId;
    const name = toolCall.toolName;

    if (name === "browser.snapshot" || name === "browser.screenshot") {
      const shot = pickScreenshot(result.output);
      if (!shot?.base64) return undefined;
      const id = newId("art");
      const file = path.join(this.artifactsRoot, `${id}.png`);
      fs.writeFileSync(file, Buffer.from(shot.base64, "base64"));
      return this.create({
        id,
        kind: "image",
        title: `Screenshot · ${new Date().toLocaleString()}`,
        uri: file,
        mimeType: shot.mimeType ?? "image/png",
        taskId,
        createdBy,
        metadata: { source: name, byteLength: shot.byteLength },
      });
    }

    if (name === "browser.extract") {
      const text = pickExtractText(result.output);
      if (!text) return undefined;
      const id = newId("art");
      const file = path.join(this.artifactsRoot, `${id}.txt`);
      fs.writeFileSync(file, text, "utf8");
      const title =
        typeof (result.output as { title?: string })?.title === "string"
          ? String((result.output as { title?: string }).title)
          : `Extract · ${new Date().toLocaleString()}`;
      return this.create({
        id,
        kind: "document",
        title,
        uri: file,
        mimeType: "text/plain",
        taskId,
        createdBy,
        metadata: { source: name, preview: text.slice(0, 240) },
      });
    }

    if (name === "browser.download") {
      const out = result.output as { path?: string; suggestedFilename?: string };
      const nested = (result.output as { output?: { path?: string; suggestedFilename?: string } })
        ?.output;
      const filePath = out.path ?? nested?.path;
      if (!filePath) return undefined;
      return this.create({
        kind: "file",
        title: out.suggestedFilename ?? nested?.suggestedFilename ?? path.basename(filePath),
        uri: filePath,
        taskId,
        createdBy,
        metadata: { source: name },
      });
    }

    return undefined;
  }
}

function pickScreenshot(output: unknown): {
  base64?: string;
  mimeType?: string;
  byteLength?: number;
} | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (typeof o.base64 === "string") {
    return {
      base64: o.base64,
      mimeType: typeof o.mimeType === "string" ? o.mimeType : undefined,
      byteLength: typeof o.byteLength === "number" ? o.byteLength : undefined,
    };
  }
  if (o.screenshot && typeof o.screenshot === "object") {
    return pickScreenshot(o.screenshot);
  }
  if (o.output && typeof o.output === "object") {
    return pickScreenshot(o.output);
  }
  return null;
}

function pickExtractText(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  if (typeof o.text === "string") return o.text;
  if (o.output && typeof o.output === "object") {
    const inner = o.output as Record<string, unknown>;
    if (typeof inner.text === "string") return inner.text;
  }
  if (o.extract && typeof o.extract === "object") {
    return pickExtractText(o.extract);
  }
  return undefined;
}
