import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type BrowserRuntimePhase =
  | "checking"
  | "downloading"
  | "extracting"
  | "ready"
  | "error";

export interface BrowserRuntimeProgress {
  phase: BrowserRuntimePhase;
  /** 0–100 when known during download. */
  percent?: number;
  message: string;
}

/** Playwright chromium install (~chrome + headless shell + ffmpeg), win/linux x64. */
export const CHROMIUM_ESTIMATED_DOWNLOAD_MB = 300;

export interface BrowserRuntimeStatus {
  installed: boolean;
  browsersPath: string;
  executablePath: string;
  /** Approximate download size when not yet installed. */
  estimatedDownloadMb: number;
}

export interface EnsureChromiumOptions {
  /** Directory Playwright will use (PLAYWRIGHT_BROWSERS_PATH). */
  browsersPath: string;
  onProgress?: (progress: BrowserRuntimeProgress) => void;
  /** Abort an in-flight install. */
  signal?: AbortSignal;
}

let installInFlight: Promise<BrowserRuntimeStatus> | null = null;
let playwrightLoadedForPath: string | null = null;

/** Must run before the first `import("playwright")` in this process. */
export function applyBrowsersPath(browsersPath: string): void {
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
}

/**
 * Load playwright only after PLAYWRIGHT_BROWSERS_PATH is set.
 * Playwright freezes the browsers path on first import — do not import it earlier.
 */
export async function loadPlaywright(browsersPath: string) {
  applyBrowsersPath(browsersPath);
  if (playwrightLoadedForPath && playwrightLoadedForPath !== browsersPath) {
    throw new Error(
      `Playwright already loaded for ${playwrightLoadedForPath}; cannot switch to ${browsersPath} in this process`,
    );
  }
  const pw = await import("playwright");
  playwrightLoadedForPath = browsersPath;
  return pw;
}

export async function getBrowserRuntimeStatus(
  browsersPath: string,
): Promise<BrowserRuntimeStatus> {
  const { chromium } = await loadPlaywright(browsersPath);
  const executablePath = chromium.executablePath();
  return {
    installed: existsSync(executablePath),
    browsersPath,
    executablePath,
    estimatedDownloadMb: CHROMIUM_ESTIMATED_DOWNLOAD_MB,
  };
}

function resolvePlaywrightCli(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("playwright/package.json");
  return join(dirname(pkg), "cli.js");
}

/**
 * Ensure Chromium is present under browsersPath (typically
 * `<userData>/ms-playwright`). Downloads via Playwright's CLI when missing.
 * Concurrent callers share one install promise.
 */
export async function ensureChromium(
  opts: EnsureChromiumOptions,
): Promise<BrowserRuntimeStatus> {
  const { browsersPath, onProgress, signal } = opts;
  mkdirSync(browsersPath, { recursive: true });
  applyBrowsersPath(browsersPath);

  const report = (progress: BrowserRuntimeProgress) => onProgress?.(progress);

  report({ phase: "checking", message: "Checking browser runtime…" });
  const current = await getBrowserRuntimeStatus(browsersPath);
  if (current.installed) {
    report({ phase: "ready", percent: 100, message: "Chromium ready" });
    return current;
  }

  if (installInFlight) return installInFlight;

  installInFlight = (async () => {
    report({
      phase: "downloading",
      percent: 0,
      message: "Downloading Chromium into app data…",
    });

    const cli = resolvePlaywrightCli();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "install", "chromium"], {
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onAbort = () => {
        child.kill("SIGTERM");
        reject(new Error("Chromium install aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const handleChunk = (buf: Buffer) => {
        const text = buf.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/(\d+)\s*%\s+of\s+/i);
          if (m) {
            const percent = Number(m[1]);
            report({
              phase: "downloading",
              percent,
              message: `Downloading Chromium… ${percent}%`,
            });
            continue;
          }
          if (/Chromium.*downloaded|chrome.*downloaded/i.test(line)) {
            report({
              phase: "extracting",
              percent: 95,
              message: "Finishing Chromium install…",
            });
          }
        }
      };

      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);

      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (code === 0) resolve();
        else reject(new Error(`playwright install chromium exited ${code}`));
      });
    });

    // Fresh status after install (playwright may already be loaded with this path)
    const after = await getBrowserRuntimeStatus(browsersPath);
    if (!after.installed) {
      report({
        phase: "error",
        message: "Chromium install finished but executable is missing",
      });
      throw new Error(
        `Chromium not found after install at ${after.executablePath}`,
      );
    }
    report({ phase: "ready", percent: 100, message: "Chromium ready" });
    return after;
  })().finally(() => {
    installInFlight = null;
  });

  try {
    return await installInFlight;
  } catch (err) {
    report({
      phase: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Default browsers dir beside the session profile root: …/ms-playwright */
export function defaultBrowsersPath(dataRoot: string): string {
  return join(dirname(dataRoot), "ms-playwright");
}
