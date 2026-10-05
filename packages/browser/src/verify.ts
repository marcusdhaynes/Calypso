/**
 * Host-side checks for browser scaffolding (Spin): navigate landed on a real
 * page, and extracts aren't empty. Failures flip ActionResult.verified so
 * runBrowserAction retries before the model sees a dead end.
 */

export function normalizeNavTarget(url: string): { hostname: string; withoutHash: string } {
  const parsed = new URL(url);
  return {
    hostname: parsed.hostname,
    withoutHash: url.split("#")[0]!,
  };
}

/** True when the page URL looks like we actually opened the requested site. */
export function urlMatchesTarget(pageUrl: string, targetUrl: string): boolean {
  try {
    const target = normalizeNavTarget(targetUrl);
    if (pageUrl.startsWith(target.withoutHash)) return true;
    const landed = new URL(pageUrl);
    if (landed.hostname === target.hostname) return true;
    // www ↔ apex
    const stripWww = (h: string) => h.replace(/^www\./i, "");
    return stripWww(landed.hostname) === stripWww(target.hostname);
  } catch {
    return false;
  }
}

/** Blank / error shells that mean navigate did not really succeed. */
export function isDeadPageUrl(pageUrl: string): boolean {
  const u = pageUrl.toLowerCase();
  return (
    u === "about:blank" ||
    u.startsWith("chrome-error://") ||
    u.startsWith("chrome://crash") ||
    u.startsWith("data:,") ||
    u === ""
  );
}

export function extractTextFromOutput(output: unknown): string {
  if (!output || typeof output !== "object") return "";
  const text = (output as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/** Non-whitespace text required for a verified extract. */
export function isNonEmptyExtract(text: string, minChars = 1): boolean {
  return text.replace(/\s+/g, " ").trim().length >= minChars;
}
