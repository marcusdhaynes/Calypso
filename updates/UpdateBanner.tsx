import React, { useEffect, useState } from "react";
import { checkForUpdate, applyUpdate, dismissVersion, isDismissed, type ReleaseInfo } from "./update-check";

/**
 * Update ribbon — thin, top-center, neutral/theme-aware. See updates/UPDATES_SPEC.md.
 * The ribbon itself is the button (click = update). The X dismisses it
 * permanently for that version. DORMANT unless imported by the app root.
 */
export function UpdateBanner() {
  const [release, setRelease] = useState<ReleaseInfo | null>(null);

  useEffect(() => {
    let alive = true;
    checkForUpdate()
      .then((r) => { if (alive && r && !isDismissed(r.version)) setRelease(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!release) return null;

  const bar: React.CSSProperties = {
    position: "fixed", top: 8, left: "50%", transform: "translateX(-50%)",
    zIndex: 9999, display: "flex", alignItems: "center", gap: 8,
    maxWidth: "92vw", padding: "3px 6px 3px 12px", borderRadius: 999,
    font: "inherit", fontSize: 12.5, lineHeight: 1.5, cursor: "pointer",
    color: "inherit", background: "rgba(127,127,127,0.16)",
    border: "1px solid rgba(127,127,127,0.35)", backdropFilter: "blur(6px)",
  };
  return (
    <div style={bar} role="button" aria-label={`Update available ${release.tag}. Activate to update.`}
      onClick={() => applyUpdate(release)}>
      <span>Update available · {release.tag}</span>
      <button type="button" aria-label="Dismiss this update"
        style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 13, padding: "0 4px", lineHeight: 1 }}
        onClick={(e) => { e.stopPropagation(); dismissVersion(release.version); setRelease(null); }}>
        ×
      </button>
    </div>
  );
}
export default UpdateBanner;
