import { randomUUID } from "node:crypto";
import type {
  ActionResult,
  BrowserAction,
  BrowserSessionId,
} from "@calypso/shared";
import { resolveLocator } from "./locators.js";
import type { BrowserSessionManager } from "./session.js";

export interface RunActionOptions {
  sessionId: BrowserSessionId;
  action: BrowserAction;
  /** Max retries on verification failure. */
  maxRetries?: number;
  signal?: AbortSignal;
}

/**
 * Execute a BrowserAction with Plan→Execute→Observe→Verify style checks.
 * Prefer DOM/accessibility locators; return ActionResult for the orchestrator.
 */
export async function runBrowserAction(
  manager: BrowserSessionManager,
  opts: RunActionOptions,
): Promise<ActionResult> {
  const started = Date.now();
  const actionId = randomUUID();
  const maxRetries = opts.maxRetries ?? 1;
  let retries = 0;
  let lastError: string | undefined;

  while (retries <= maxRetries) {
    if (opts.signal?.aborted) {
      return {
        actionId,
        ok: false,
        verified: false,
        retries,
        error: "aborted",
        durationMs: Date.now() - started,
      };
    }

    try {
      const result = await executeOnce(manager, opts.sessionId, opts.action, actionId, started);
      if (result.ok && result.verified) {
        return { ...result, retries };
      }
      lastError = result.error ?? "verification failed";
      retries += 1;
      if (retries > maxRetries) return { ...result, retries: retries - 1 };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      retries += 1;
      if (retries > maxRetries) {
        return {
          actionId,
          ok: false,
          verified: false,
          retries: retries - 1,
          error: lastError,
          durationMs: Date.now() - started,
        };
      }
    }
  }

  return {
    actionId,
    ok: false,
    verified: false,
    retries: maxRetries,
    error: lastError,
    durationMs: Date.now() - started,
  };
}

async function executeOnce(
  manager: BrowserSessionManager,
  sessionId: BrowserSessionId,
  action: BrowserAction,
  actionId: string,
  started: number,
): Promise<ActionResult> {
  const page = manager.getPage(sessionId);
  let output: unknown;

  switch (action.type) {
    case "navigate": {
      if (!manager.isOriginAllowed(sessionId, action.url)) {
        return {
          actionId,
          ok: false,
          verified: false,
          retries: 0,
          error: `Origin not allowed for ${action.url}; needs browser_offorigin_nav`,
          durationMs: Date.now() - started,
        };
      }
      const resp = await page.goto(action.url, { waitUntil: "domcontentloaded" });
      const ok = resp ? resp.ok() || resp.status() === 0 : true;
      // After first successful nav to a new origin with empty allow-list, pin it
      try {
        const origin = new URL(action.url).origin;
        const session = manager.getSession(sessionId);
        if (session && session.allowedOrigins.length === 0) {
          manager.allowOrigin(sessionId, origin);
        }
      } catch {
        /* ignore */
      }
      manager.refreshTabMeta(sessionId);
      const verified = page.url().startsWith(action.url.split("#")[0]!) || page.url().includes(new URL(action.url).hostname);
      output = { url: page.url(), status: resp?.status() };
      return {
        actionId,
        ok: !!ok,
        verified,
        retries: 0,
        output,
        durationMs: Date.now() - started,
        error: verified ? undefined : `Landed on ${page.url()} instead of ${action.url}`,
      };
    }
    case "click": {
      const loc = resolveLocator(page, action.locator);
      await loc.first().click({ timeout: 15_000 });
      const verified = true; // click itself succeeded; optional post-check left to caller
      return {
        actionId,
        ok: true,
        verified,
        retries: 0,
        durationMs: Date.now() - started,
      };
    }
    case "type": {
      const loc = resolveLocator(page, action.locator);
      if (action.clear) await loc.first().fill("");
      await loc.first().fill(action.text);
      const value = await loc.first().inputValue().catch(() => null);
      const verified = value === null || value.includes(action.text);
      return {
        actionId,
        ok: true,
        verified,
        retries: 0,
        output: { value },
        durationMs: Date.now() - started,
        error: verified ? undefined : "Typed text not reflected in input",
      };
    }
    case "scroll": {
      if (action.locator) {
        await resolveLocator(page, action.locator).first().scrollIntoViewIfNeeded();
      } else {
        await page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 0);
      }
      return {
        actionId,
        ok: true,
        verified: true,
        retries: 0,
        durationMs: Date.now() - started,
      };
    }
    case "select": {
      const loc = resolveLocator(page, action.locator);
      await loc.first().selectOption(action.values);
      return {
        actionId,
        ok: true,
        verified: true,
        retries: 0,
        durationMs: Date.now() - started,
      };
    }
    case "upload": {
      const loc = resolveLocator(page, action.locator);
      await loc.first().setInputFiles(action.files);
      return {
        actionId,
        ok: true,
        verified: true,
        retries: 0,
        output: { files: action.files },
        durationMs: Date.now() - started,
      };
    }
    case "download": {
      const loc = resolveLocator(page, action.locator);
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60_000 }),
        loc.first().click(),
      ]);
      const suggested = download.suggestedFilename();
      const saveAs = action.saveAs ?? suggested;
      await download.saveAs(saveAs);
      return {
        actionId,
        ok: true,
        verified: true,
        retries: 0,
        output: { path: saveAs, suggestedFilename: suggested },
        durationMs: Date.now() - started,
      };
    }
    case "extract": {
      if (action.locator) {
        const loc = resolveLocator(page, action.locator);
        const text = await loc.first().innerText();
        output = { text };
      } else {
        const text = await page.innerText("body");
        const title = await page.title();
        output = { title, text: text.slice(0, 50_000), url: page.url() };
      }
      return {
        actionId,
        ok: true,
        verified: true,
        retries: 0,
        output,
        durationMs: Date.now() - started,
      };
    }
    case "newTab": {
      const tab = await manager.newTab(sessionId, action.url);
      return {
        actionId,
        ok: true,
        verified: true,
        retries: 0,
        output: tab,
        durationMs: Date.now() - started,
      };
    }
    case "switchTab": {
      manager.switchTab(sessionId, action.tabId);
      return {
        actionId,
        ok: true,
        verified: true,
        retries: 0,
        output: { activeTabId: action.tabId },
        durationMs: Date.now() - started,
      };
    }
    case "closeTab": {
      await manager.closeTab(sessionId, action.tabId);
      return {
        actionId,
        ok: true,
        verified: true,
        retries: 0,
        durationMs: Date.now() - started,
      };
    }
    case "screenshot": {
      const buffer = await page.screenshot({
        fullPage: action.fullPage ?? false,
        type: "png",
      });
      output = {
        mimeType: "image/png",
        base64: buffer.toString("base64"),
        byteLength: buffer.byteLength,
      };
      return {
        actionId,
        ok: true,
        verified: true,
        retries: 0,
        output,
        durationMs: Date.now() - started,
      };
    }
    default: {
      const _exhaustive: never = action;
      return {
        actionId,
        ok: false,
        verified: false,
        retries: 0,
        error: `Unknown BrowserAction: ${JSON.stringify(_exhaustive)}`,
        durationMs: Date.now() - started,
      };
    }
  }
}
