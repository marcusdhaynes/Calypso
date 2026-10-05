import { join } from "node:path";
import type { Tool } from "@calypso/shared";
import { BrowserSessionManager } from "./session.js";
import type { SessionManagerOptions } from "./session.js";
import { createBrowserTools } from "./tools.js";
import {
  applyBrowsersPath,
  CHROMIUM_ESTIMATED_DOWNLOAD_MB,
  defaultBrowsersPath,
  ensureChromium,
  getBrowserRuntimeStatus,
} from "./runtime.js";
import type {
  BrowserRuntimeProgress,
  BrowserRuntimeStatus,
  EnsureChromiumOptions,
} from "./runtime.js";

export { BrowserSessionManager } from "./session.js";
export type { SessionManagerOptions } from "./session.js";
export { resolveLocator } from "./locators.js";
export { runBrowserAction } from "./actions.js";
export type { RunActionOptions } from "./actions.js";
export {
  extractTextFromOutput,
  isDeadPageUrl,
  isNonEmptyExtract,
  normalizeNavTarget,
  urlMatchesTarget,
} from "./verify.js";
export { createBrowserTools } from "./tools.js";
export {
  applyBrowsersPath,
  CHROMIUM_ESTIMATED_DOWNLOAD_MB,
  defaultBrowsersPath,
  ensureChromium,
  getBrowserRuntimeStatus,
};
export type {
  BrowserRuntimePhase,
  BrowserRuntimeProgress,
  BrowserRuntimeStatus,
  EnsureChromiumOptions,
} from "./runtime.js";

export interface BrowserControl {
  manager: BrowserSessionManager;
  tools: Tool[];
  browsersPath: string;
  ensureRuntime(): Promise<BrowserRuntimeStatus>;
  getRuntimeStatus(): Promise<BrowserRuntimeStatus>;
  dispose(): Promise<void>;
}

export interface BrowserControlOptions {
  /** Persistent profile root. Defaults to `<cwd>/.calypso/browser`. */
  dataRoot?: string;
  /** Chromium cache (PLAYWRIGHT_BROWSERS_PATH). Defaults to sibling `ms-playwright`. */
  browsersPath?: string;
  headless?: boolean;
  defaultAllowedOrigins?: string[];
  onRuntimeProgress?: (progress: BrowserRuntimeProgress) => void;
}

/**
 * Wire into the core utility process:
 *   const browser = createBrowserControl({
 *     dataRoot: join(userData, "browser"),
 *     browsersPath: join(userData, "ms-playwright"),
 *     onRuntimeProgress: (p) => bus.publish({ type: "browser.runtime.progress", progress: p, at: Date.now() }),
 *   });
 *   for (const tool of browser.tools) orchestrator.registerTool(tool);
 *   await browser.ensureRuntime(); // first-run / before browse
 *   const session = await browser.manager.openSession({ workerId });
 *   await browser.dispose();
 */
export function createBrowserControl(
  opts: BrowserControlOptions = {},
): BrowserControl {
  const dataRoot = opts.dataRoot ?? join(process.cwd(), ".calypso", "browser");
  const browsersPath = opts.browsersPath ?? defaultBrowsersPath(dataRoot);
  const managerOpts: SessionManagerOptions = {
    dataRoot,
    browsersPath,
    headless: opts.headless ?? process.env.CALYPSO_BROWSER_HEADED !== "1",
    defaultAllowedOrigins: opts.defaultAllowedOrigins,
    onRuntimeProgress: opts.onRuntimeProgress,
  };
  applyBrowsersPath(browsersPath);
  const manager = new BrowserSessionManager(managerOpts);
  return {
    manager,
    tools: createBrowserTools(manager),
    browsersPath,
    async ensureRuntime() {
      return ensureChromium({
        browsersPath,
        onProgress: opts.onRuntimeProgress,
      });
    },
    getRuntimeStatus() {
      return getBrowserRuntimeStatus(browsersPath);
    },
    dispose: () => manager.dispose(),
  };
}
