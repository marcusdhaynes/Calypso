import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "native/win32-x64/better_sqlite3.node");
const dest = join(
  root,
  "release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
);
if (!existsSync(src)) {
  console.error("Missing vendored Windows better_sqlite3.node at", src);
  process.exit(1);
}
if (!existsSync(dest)) {
  console.error("Pack output missing better_sqlite3.node at", dest);
  process.exit(1);
}
copyFileSync(src, dest);
console.log("Patched Windows better_sqlite3.node into", dest);
