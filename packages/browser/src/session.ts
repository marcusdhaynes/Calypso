import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  BrowserSession,
  BrowserSessionId,
  BrowserTab,
  ProjectId,
  WorkerId,
} from "@calypso/shared";

export interface SessionManagerOptions {
  /** Root for persistent Playwright user-data dirs (cookies, storage, downloads). */
  dataRoot: string;
  headless?: boolean;
  /** Default origin allow-list for new sessions (empty = unrestricted until first nav sets origin). */
  defaultAllowedOrigins?: string[];
}

interface LiveSession {
  meta: BrowserSession;
  context: BrowserContext;
  pages: Map<string, Page>;
}

/**
 * One Chromium browser process, many persistent contexts (one per worker/session).
 * Contexts keep cookies, localStorage, and download history across restarts of the same id.
 */
export class BrowserSessionManager {
  private browser: Browser | null = null;
  private sessions = new Map<BrowserSessionId, LiveSession>();
  private readonly opts: Required<Pick<SessionManagerOptions, "dataRoot" | "headless">> &
    SessionManagerOptions;

  constructor(opts: SessionManagerOptions) {
    this.opts = { headless: true, ...opts };
    mkdirSync(this.opts.dataRoot, { recursive: true });
  }

  async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.launch({
      headless: this.opts.headless,
      args: ["--disable-dev-shm-usage"],
    });
    return this.browser;
  }

  async openSession(args: {
    workerId: WorkerId;
    projectId?: ProjectId;
    allowedOrigins?: string[];
    sessionId?: BrowserSessionId;
  }): Promise<BrowserSession> {
    const id = args.sessionId ?? randomUUID();
    const existing = this.sessions.get(id);
    if (existing) return existing.meta;

    const profileDir = join(this.opts.dataRoot, id);
    mkdirSync(profileDir, { recursive: true });

    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1280, height: 800 },
      // Persistent storage via storageState file written on close; profileDir holds downloads.
      // Full persistent-context launch is alternative; we use storageState for multi-session on one browser.
    });

    // Restore storage if present
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const statePath = join(profileDir, "storage.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        await context.addCookies(state.cookies ?? []);
        // origins localStorage restored via storageState on next open — use full storageState API
      }
    } catch {
      /* fresh session */
    }

    const page = await context.newPage();
    const tabId = randomUUID();
    const tab: BrowserTab = { id: tabId, url: page.url(), title: await page.title() };
    const now = Date.now();
    const meta: BrowserSession = {
      id,
      workerId: args.workerId,
      projectId: args.projectId,
      activeTabId: tabId,
      tabs: [tab],
      allowedOrigins: args.allowedOrigins ?? this.opts.defaultAllowedOrigins ?? [],
      createdAt: now,
      updatedAt: now,
    };

    const pages = new Map<string, Page>([[tabId, page]]);
    this.wirePageEvents(id, tabId, page);
    this.sessions.set(id, { meta, context, pages });
    return meta;
  }

  getSession(id: BrowserSessionId): BrowserSession | undefined {
    return this.sessions.get(id)?.meta;
  }

  getPage(sessionId: BrowserSessionId, tabId?: string): Page {
    const live = this.require(sessionId);
    const tid = tabId ?? live.meta.activeTabId;
    const page = live.pages.get(tid);
    if (!page) throw new Error(`Tab ${tid} not found in session ${sessionId}`);
    return page;
  }

  async newTab(sessionId: BrowserSessionId, url?: string): Promise<BrowserTab> {
    const live = this.require(sessionId);
    const page = await live.context.newPage();
    const tabId = randomUUID();
    if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
    const tab: BrowserTab = {
      id: tabId,
      url: page.url(),
      title: await page.title(),
    };
    live.pages.set(tabId, page);
    live.meta.tabs.push(tab);
    live.meta.activeTabId = tabId;
    live.meta.updatedAt = Date.now();
    this.wirePageEvents(sessionId, tabId, page);
    return tab;
  }

  switchTab(sessionId: BrowserSessionId, tabId: string): void {
    const live = this.require(sessionId);
    if (!live.pages.has(tabId)) throw new Error(`Tab ${tabId} not found`);
    live.meta.activeTabId = tabId;
    live.meta.updatedAt = Date.now();
  }

  async closeTab(sessionId: BrowserSessionId, tabId: string): Promise<void> {
    const live = this.require(sessionId);
    const page = live.pages.get(tabId);
    if (!page) throw new Error(`Tab ${tabId} not found`);
    await page.close();
    live.pages.delete(tabId);
    live.meta.tabs = live.meta.tabs.filter((t) => t.id !== tabId);
    if (live.meta.activeTabId === tabId) {
      const next = live.meta.tabs[0];
      if (!next) {
        // keep at least one tab
        const fresh = await live.context.newPage();
        const nid = randomUUID();
        live.pages.set(nid, fresh);
        const tab: BrowserTab = { id: nid, url: fresh.url(), title: "" };
        live.meta.tabs = [tab];
        live.meta.activeTabId = nid;
        this.wirePageEvents(sessionId, nid, fresh);
      } else {
        live.meta.activeTabId = next.id;
      }
    }
    live.meta.updatedAt = Date.now();
  }

  /** True if url's origin is allowed, or allow-list is empty (first-run open). */
  isOriginAllowed(sessionId: BrowserSessionId, url: string): boolean {
    const live = this.require(sessionId);
    if (live.meta.allowedOrigins.length === 0) return true;
    try {
      const origin = new URL(url).origin;
      return live.meta.allowedOrigins.includes(origin);
    } catch {
      return false;
    }
  }

  allowOrigin(sessionId: BrowserSessionId, origin: string): void {
    const live = this.require(sessionId);
    if (!live.meta.allowedOrigins.includes(origin)) {
      live.meta.allowedOrigins.push(origin);
      live.meta.updatedAt = Date.now();
    }
  }

  refreshTabMeta(sessionId: BrowserSessionId): void {
    const live = this.require(sessionId);
    for (const tab of live.meta.tabs) {
      const page = live.pages.get(tab.id);
      if (!page) continue;
      tab.url = page.url();
      void page.title().then((t) => {
        tab.title = t;
      });
    }
    live.meta.updatedAt = Date.now();
  }

  async closeSession(sessionId: BrowserSessionId): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    try {
      const state = await live.context.storageState();
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(this.opts.dataRoot, sessionId, "storage.json"),
        JSON.stringify(state),
      );
    } catch {
      /* best-effort persist */
    }
    await live.context.close();
    this.sessions.delete(sessionId);
  }

  async dispose(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.closeSession(id);
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private require(sessionId: BrowserSessionId): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error(`Browser session ${sessionId} not found`);
    return live;
  }

  private wirePageEvents(sessionId: BrowserSessionId, tabId: string, page: Page): void {
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const live = this.sessions.get(sessionId);
      if (!live) return;
      const tab = live.meta.tabs.find((t) => t.id === tabId);
      if (tab) {
        tab.url = page.url();
        void page.title().then((t) => {
          tab.title = t;
        });
        live.meta.updatedAt = Date.now();
      }
    });
  }
}
