import type { Artifact, ArtifactKind } from "@calypso/shared";
import { colors, radii, space } from "../theme/tokens.js";

export interface ArtifactsPanelProps {
  artifacts: Artifact[];
  selectedId?: string | null;
  onSelect?: (artifact: Artifact) => void;
  onDelete?: (artifactId: string) => void;
  emptyHint?: string;
  className?: string;
}

const KIND_LABEL: Record<ArtifactKind, string> = {
  code: "Code",
  document: "Extract",
  image: "Screenshot",
  table: "Table",
  chart: "Chart",
  file: "File",
  plan: "Plan",
  website: "Website",
};

function kindBadge(kind: ArtifactKind): string {
  if (kind === "image") return "Screenshot";
  if (kind === "document") return "Extract";
  return KIND_LABEL[kind] ?? kind;
}

function previewText(a: Artifact): string | undefined {
  const p = a.metadata?.preview;
  return typeof p === "string" ? p : undefined;
}

export function ArtifactsPanel({
  artifacts,
  selectedId,
  onSelect,
  onDelete,
  emptyHint = "Screenshots, extracts, and files from workers show up here.",
  className,
}: ArtifactsPanelProps) {
  return (
    <section
      className={className}
      aria-label="Artifacts"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space[5],
        minHeight: 0,
        height: "100%",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: space[5] }}>
        <h2
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 650,
            letterSpacing: "-0.02em",
            color: colors.textPrimary,
          }}
        >
          Artifacts
        </h2>
        <span style={{ fontSize: 12, color: colors.textMuted }}>
          {artifacts.length === 0 ? "empty" : `${artifacts.length}`}
        </span>
      </header>

      {artifacts.length === 0 ? (
        <div
          style={{
            padding: space[7],
            borderRadius: radii.lg,
            border: `1px dashed ${colors.border}`,
            color: colors.textMuted,
            fontSize: 13,
            lineHeight: 1.45,
            background: colors.raised,
          }}
        >
          {emptyHint}
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: space[4],
            overflow: "auto",
            minHeight: 0,
          }}
        >
          {artifacts.map((a) => {
            const active = a.id === selectedId;
            const preview = previewText(a);
            return (
              <li key={a.id}>
                <button
                  type="button"
                  className="cal-focus-ring"
                  data-testid={`artifact-${a.id}`}
                  onClick={() => onSelect?.(a)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: space[5],
                    borderRadius: radii.md,
                    border: `1px solid ${active ? "rgba(56, 210, 193, 0.35)" : colors.border}`,
                    background: active ? colors.accentSoft : colors.raised,
                    color: colors.textPrimary,
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: space[4] }}>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 650,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        color: colors.accent,
                        background: "rgba(56, 210, 193, 0.12)",
                        padding: "2px 8px",
                        borderRadius: 999,
                      }}
                    >
                      {kindBadge(a.kind)}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        fontSize: 13.5,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.title}
                    </span>
                    {onDelete ? (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`Delete ${a.title}`}
                        data-testid={`artifact-delete-${a.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(a.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            onDelete(a.id);
                          }
                        }}
                        style={{
                          fontSize: 11,
                          color: colors.textMuted,
                          padding: "2px 6px",
                        }}
                      >
                        Remove
                      </span>
                    ) : null}
                  </div>
                  {preview ? (
                    <div
                      style={{
                        fontSize: 12,
                        color: colors.textSecondary,
                        lineHeight: 1.4,
                        maxHeight: 40,
                        overflow: "hidden",
                      }}
                    >
                      {preview}
                    </div>
                  ) : (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: colors.textMuted,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                      title={a.uri}
                    >
                      {a.uri}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: colors.textMuted }}>
                    {new Date(a.createdAt).toLocaleString()}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
