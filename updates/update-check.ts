// Uniform auto-update check — see updates/UPDATES_SPEC.md
// Checks this repo's GitHub Releases and compares semver against the current version.
export const GITHUB_REPO = "marcusdhaynes/Calypso";
export const CURRENT_VERSION = "0.2.0"; // from package.json at rollout

export interface ReleaseInfo {
  version: string; // e.g. "1.2.3" (tag without leading "v")
  tag: string;
  notes: string;
  url: string;
  publishedAt: string | null;
}

export function parseSemver(v: string): number[] {
  return v.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
}

/** Returns >0 if a is newer than b, <0 if older, 0 if equal. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    { headers: { Accept: "application/vnd.github+json" } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.tag_name) return null;
  return {
    version: String(data.tag_name).replace(/^v/i, ""),
    tag: String(data.tag_name),
    notes: data.body || "",
    url: data.html_url || `https://github.com/${GITHUB_REPO}/releases`,
    publishedAt: data.published_at ?? null,
  };
}

export async function checkForUpdate(
  currentVersion: string = CURRENT_VERSION
): Promise<ReleaseInfo | null> {
  const latest = await fetchLatestRelease();
  if (!latest) return null;
  return compareSemver(latest.version, currentVersion) > 0 ? latest : null;
}

const DISMISS_KEY = "updates:dismissed:";

export function isDismissed(version: string): boolean {
  try { return localStorage.getItem(DISMISS_KEY + version) === "1"; } catch { return false; }
}
export function dismissVersion(version: string): void {
  try { localStorage.setItem(DISMISS_KEY + version, "1"); } catch {}
}

/** Web apps refresh to the deployed version; native builds open the release page
 *  so the platform install flow (e.g. Android's install tap) can run. */
export function applyUpdate(release: ReleaseInfo): void {
  const isHttp = typeof window !== "undefined" && /^https?:$/.test(window.location.protocol);
  if (isHttp) { window.location.reload(); return; }
  window.open(release.url, "_blank", "noopener");
}
