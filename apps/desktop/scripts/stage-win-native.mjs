import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(root, "../..");
const src = join(root, "native/win32-x64/better_sqlite3.node");
const dest = join(
  repoRoot,
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node"
);

if (!existsSync(src)) {
  console.error("Missing vendored Windows better_sqlite3.node at", src);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log("Staged Windows better_sqlite3.node at", dest);
