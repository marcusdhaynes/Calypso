import { join } from "node:path";
import type { Tool } from "@calypso/shared";
import { BrowserSessionManager } from "./session.js";
import type { SessionManagerOptions } from "./session.js";
import { createBrowserTools } from "./tools.js";

export { BrowserSessionManager } from "./session.js";
export type { SessionManagerOptions } from "./session.js";
export { resolveLocator } from "./locators.js";
export { runBrowserAction } from "./actions.js";
export type { RunActionOptions } from "./actions.js";
export { createBrowserTools } from "./tools.js";

export interface BrowserControl {
  manager: BrowserSessionManager;
  tools: Tool[];
  dispose(): Promise<void>;
}

export interface BrowserControlOptions {
  /** Persistent profile root. Defaults to `<cwd>/.calypso/browser`. */
  dataRoot?: string;
  headless?: boolean;
  defaultAllowedOrigins?: string[];
}

/**
 * Wire into the core utility process:
 *   const browser = createBrowserControl({ dataRoot: join(userData, "browser") });
 *   for (const tool of browser.tools) orchestrator.registerTool(tool);
 *   // before a worker browses:
 *   const session = await browser.manager.openSession({ workerId, projectId });
 *   // tools take { sessionId: session.id, ... }
 *   // on quit: await browser.dispose();
 */
export function createBrowserControl(
  opts: BrowserControlOptions = {},
): BrowserControl {
  const managerOpts: SessionManagerOptions = {
    dataRoot: opts.dataRoot ?? join(process.cwd(), ".calypso", "browser"),
    headless: opts.headless ?? process.env.CALYPSO_BROWSER_HEADED !== "1",
    defaultAllowedOrigins: opts.defaultAllowedOrigins,
  };
  const manager = new BrowserSessionManager(managerOpts);
  return {
    manager,
    tools: createBrowserTools(manager),
    dispose: () => manager.dispose(),
  };
}
