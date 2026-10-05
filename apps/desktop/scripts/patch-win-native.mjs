import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "native/win32-x64/better_sqlite3.node");
const unpackedRoot = join(root, "release/win-unpacked/resources");

function findExistingNode(dir, depth = 0) {
  if (!existsSync(dir) || depth > 10) return null;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isFile() && name.name === "better_sqlite3.node") return full;
    if (name.isDirectory()) {
      const hit = findExistingNode(full, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

if (!existsSync(src)) {
  console.error("Missing vendored Windows better_sqlite3.node at", src);
  process.exit(1);
}

const preferred = join(
  unpackedRoot,
  "app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
);
let dest = existsSync(preferred) ? preferred : findExistingNode(unpackedRoot);

if (!dest) {
  // smartUnpack may have missed it — force the canonical unpacked path
  dest = preferred;
  mkdirSync(dirname(dest), { recursive: true });
  console.warn("No unpacked better_sqlite3.node found; writing canonical path", dest);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log("Patched Windows better_sqlite3.node into", dest);
