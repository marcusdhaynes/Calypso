import React, { useEffect, useState } from "react";
import { CURRENT_VERSION, fetchLatestRelease, compareSemver, applyUpdate, type ReleaseInfo } from "./update-check";

/**
 * Updates section — rendered permanently at the very BOTTOM of Settings.
 * See updates/UPDATES_SPEC.md. DORMANT unless imported by the Settings view.
 */
export function UpdatesSection() {
  const [latest, setLatest] = useState<ReleaseInfo | null>(null);
  const [status, setStatus] = useState<"idle" | "checking" | "uptodate" | "error">("idle");

  const check = async () => {
    setStatus("checking");
    try {
      const rel = await fetchLatestRelease();
      if (!rel) { setStatus("error"); return; }
      setLatest(rel);
      setStatus(compareSemver(rel.version, CURRENT_VERSION) > 0 ? "idle" : "uptodate");
    } catch { setStatus("error"); }
  };

  useEffect(() => { void check(); }, []);

  const updateAvailable = latest && compareSemver(latest.version, CURRENT_VERSION) > 0;

  return (
    <section aria-label="Updates" style={{ marginTop: 24 }}>
      <h2>Updates</h2>
      <p>Current version: {CURRENT_VERSION}</p>
      <p>Available version: {latest ? latest.tag : status === "checking" ? "Checking…" : "—"}</p>
      {updateAvailable && latest?.notes ? (
        <div><h3>What's New</h3><pre style={{ whiteSpace: "pre-wrap", font: "inherit" }}>{latest.notes}</pre></div>
      ) : null}
      {status === "uptodate" && <p>You're up to date.</p>}
      {status === "error" && <p>Couldn't check for updates. Try again later.</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => void check()} disabled={status === "checking"}>Check for updates</button>
        {updateAvailable && latest ? (
          <button type="button" onClick={() => applyUpdate(latest)}>Update</button>
        ) : null}
      </div>
    </section>
  );
}
export default UpdatesSection;
