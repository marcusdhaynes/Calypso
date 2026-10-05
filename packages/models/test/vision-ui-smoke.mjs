#!/usr/bin/env node
/**
 * Best-effort vision UI smoke for qwen2.5vl:3b via Ollama.
 *
 * Skips cleanly (exit 0) when Ollama is unreachable or the model is not pulled.
 * Does NOT fail the build if Ollama is missing.
 *
 * Live tokens/sec + vision UI bench belong on DESKTOP-J47PDQK — do not pull
 * large models on this Linux box (~2 GB free RAM).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const OLLAMA = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const MODEL = "qwen2.5vl:3b";
const ROOT = new URL("../..", import.meta.url).pathname; // packages/
const REPO = join(ROOT, ".."); // /workspace/calypso

function skip(reason) {
  console.log(`[vision-ui-smoke] SKIP: ${reason}`);
  process.exit(0);
}

/** Minimal 8×8 solid red PNG (valid, tiny). */
function syntheticPngBase64() {
  // Precomputed 8x8 red PNG
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGP8z4ADGDEwjEoAAQX+Af1dY9YzAAAAAElFTkSuQmCC";
  return b64;
}

function findScreenshot() {
  const candidates = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3 || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(png|jpe?g|webp)$/i.test(e.name) && !p.includes("node_modules")) {
        candidates.push(p);
      }
    }
  };
  // Prefer repo screenshots outside node_modules
  for (const sub of ["", "packages/ui", "packages/models", "screenshots", "assets"]) {
    walk(join(REPO, sub), 0);
  }
  return candidates[0] ?? null;
}

async function main() {
  let tags;
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) skip(`Ollama /api/tags returned ${res.status}`);
    tags = await res.json();
  } catch (err) {
    skip(`Ollama not reachable at ${OLLAMA} (${err?.cause?.code ?? err.message})`);
  }

  const names = (tags?.models ?? []).map((m) => m.name ?? m.model ?? "");
  const hasModel = names.some(
    (n) => n === MODEL || n.startsWith(`${MODEL}:`) || n.startsWith("qwen2.5vl:3b")
  );
  if (!hasModel) {
    skip(
      `${MODEL} not listed in Ollama (have: ${names.slice(0, 8).join(", ") || "none"}). Pull on DESKTOP-J47PDQK — do not pull here.`
    );
  }

  const shot = findScreenshot();
  let imageB64;
  let imageNote;
  if (shot) {
    imageB64 = readFileSync(shot).toString("base64");
    imageNote = `screenshot ${shot}`;
  } else {
    imageB64 = syntheticPngBase64();
    imageNote = "synthetic 8x8 PNG";
  }

  console.log(`[vision-ui-smoke] Using model ${MODEL}, image: ${imageNote}`);

  const prompt =
    "List any UI elements you can see. For each, give a short label and an approximate bounding box as [x,y,w,h] in pixels (or say none if the image has no UI). Be brief.";

  const body = {
    model: MODEL,
    stream: false,
    messages: [
      {
        role: "user",
        content: prompt,
        images: [imageB64],
      },
    ],
  };

  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.log(`[vision-ui-smoke] Ollama chat failed: ${res.status} ${t.slice(0, 200)}`);
      // Soft fail — do not fail the build
      process.exit(0);
    }
    const data = await res.json();
    const content = data?.message?.content ?? JSON.stringify(data).slice(0, 500);
    console.log("[vision-ui-smoke] RESULT:");
    console.log(content);
    process.exit(0);
  } catch (err) {
    console.log(`[vision-ui-smoke] request error (soft): ${err.message}`);
    process.exit(0);
  }
}

main();
