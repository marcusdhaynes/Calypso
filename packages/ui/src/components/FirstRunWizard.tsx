/**
 * Presentational first-run flow (section 28).
 * Plan data comes from Angen's `planFirstRunInference` via main/core IPC —
 * do not import @calypso/models in the renderer (Node APIs).
 */
import { useState } from "react";
import { Button } from "./Button.js";
import { colors, radii, shadows, space, typography } from "../theme/tokens.js";

export interface FirstRunModelRow {
  model: string;
  purpose: string;
  estimatedDownloadMb: number;
  usedBy: string[];
}

export interface FirstRunPlanView {
  gpuDetected: boolean;
  gpuName?: string;
  vramGb?: number;
  cpuCores: number;
  totalMemoryGb: number;
  modelsToDownload: FirstRunModelRow[];
  embedding: { model: string; estimatedDownloadMb: number; notes: string };
  notes: string[];
  visionSwapPolicy: string;
}

export interface FirstRunWizardProps {
  plan: FirstRunPlanView;
  onComplete: (opts: { createDefaultWorker: boolean }) => void;
  onSkip?: () => void;
}

type Step = "welcome" | "hardware" | "models" | "permissions" | "worker" | "done";

const STEPS: Step[] = ["welcome", "hardware", "models", "permissions", "worker", "done"];

function formatMb(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function FirstRunWizard({ plan, onComplete, onSkip }: FirstRunWizardProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [createWorker, setCreateWorker] = useState(true);
  const idx = STEPS.indexOf(step);

  const next = () => {
    const n = STEPS[idx + 1];
    if (n) setStep(n);
  };
  const back = () => {
    const p = STEPS[idx - 1];
    if (p) setStep(p);
  };

  return (
    <div
      style={{
        minHeight: "100%",
        display: "grid",
        placeItems: "center",
        padding: space[12],
        background: `radial-gradient(120% 80% at 50% 0%, rgba(56, 210, 193, 0.14), transparent 55%), ${colors.abyss}`,
      }}
    >
      <section
        className="cal-fade-in"
        style={{
          width: "100%",
          maxWidth: 560,
          background: colors.surface,
          borderRadius: radii["2xl"],
          border: `1px solid ${colors.borderStrong}`,
          boxShadow: shadows.lg,
          padding: space[12],
          display: "flex",
          flexDirection: "column",
          gap: space[8],
        }}
      >
        <header>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: colors.accent }}>
            Setup · {idx + 1}/{STEPS.length}
          </div>
          <h1 style={{ margin: `${space[4]} 0 0`, fontSize: typography.size["2xl"], fontWeight: 700, letterSpacing: "-0.02em" }}>
            {step === "welcome" && "Welcome to Calypso"}
            {step === "hardware" && "Your hardware"}
            {step === "models" && "Local models"}
            {step === "permissions" && "Permissions"}
            {step === "worker" && "First worker"}
            {step === "done" && "You're ready"}
          </h1>
        </header>

        <div style={{ color: colors.textSecondary, fontSize: 14.5, lineHeight: 1.55, minHeight: 160 }}>
          {step === "welcome" && (
            <p style={{ margin: 0 }}>
              Calypso runs a local AI workforce on your PC. We'll detect your GPU, recommend models that fit, and create your first worker — no terminal required.
            </p>
          )}
          {step === "hardware" && (
            <div style={{ display: "flex", flexDirection: "column", gap: space[4] }}>
              <Row label="GPU" value={plan.gpuDetected ? (plan.gpuName ?? "Detected") : "Not detected (CPU mode)"} />
              <Row label="VRAM" value={plan.vramGb != null ? `${plan.vramGb} GB` : "—"} />
              <Row label="CPU / RAM" value={`${plan.cpuCores} cores · ${plan.totalMemoryGb} GB`} />
              {plan.notes.slice(0, 2).map((n) => (
                <p key={n} style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
                  {n}
                </p>
              ))}
            </div>
          )}
          {step === "models" && (
            <div style={{ display: "flex", flexDirection: "column", gap: space[5] }}>
              <p style={{ margin: 0, fontSize: 13 }}>
                Recommended downloads (Ollama). Vision swaps with the chat model under 8 GB VRAM.
              </p>
              {plan.modelsToDownload.map((m) => (
                <div
                  key={m.model}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: space[6],
                    padding: space[6],
                    borderRadius: radii.lg,
                    background: colors.raised,
                    border: `1px solid ${colors.border}`,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, color: colors.textPrimary, fontFamily: typography.fontMono, fontSize: 13 }}>
                      {m.model}
                    </div>
                    <div style={{ fontSize: 12, color: colors.textMuted }}>{m.purpose}</div>
                  </div>
                  <div style={{ fontSize: 12, color: colors.accent, whiteSpace: "nowrap" }}>{formatMb(m.estimatedDownloadMb)}</div>
                </div>
              ))}
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                Embeddings: {plan.embedding.model} ({formatMb(plan.embedding.estimatedDownloadMb)}, CPU) — {plan.embedding.notes}
              </div>
            </div>
          )}
          {step === "permissions" && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>Computer control can pause, stop, or take over anytime.</li>
              <li>Workers start on Ask for destructive actions.</li>
              <li>Browser runtime (Chromium) downloads on first use into app data — not bundled in Calypso.exe.</li>
              <li>Microphone is optional — enable later for voice.</li>
              <li>Credentials stay in the OS credential store, never in logs.</li>
            </ul>
          )}
          {step === "worker" && (
            <div>
              <p style={{ marginTop: 0 }}>Create a default Assistant worker you can talk to immediately.</p>
              <label style={{ display: "flex", alignItems: "center", gap: space[5], cursor: "pointer" }}>
                <input type="checkbox" checked={createWorker} onChange={(e) => setCreateWorker(e.target.checked)} />
                Create “Assistant” (trusted for read, ask for write)
              </label>
            </div>
          )}
          {step === "done" && (
            <p style={{ margin: 0 }}>Calypso is ready. You can change models, voice, and permissions anytime in Settings.</p>
          )}
        </div>

        <footer style={{ display: "flex", justifyContent: "space-between", gap: space[4] }}>
          <div>
            {idx > 0 && step !== "done" ? (
              <Button variant="ghost" onClick={back}>
                Back
              </Button>
            ) : onSkip && step === "welcome" ? (
              <Button variant="ghost" onClick={onSkip}>
                Skip for now
              </Button>
            ) : (
              <span />
            )}
          </div>
          <div style={{ display: "flex", gap: space[3] }}>
            {step !== "done" ? (
              <Button variant="primary" onClick={next}>
                Continue
              </Button>
            ) : (
              <Button variant="primary" onClick={() => onComplete({ createDefaultWorker: createWorker })}>
                Enter Calypso
              </Button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: space[8] }}>
      <span style={{ color: colors.textMuted }}>{label}</span>
      <span style={{ color: colors.textPrimary, fontWeight: 500, textAlign: "right" }}>{value}</span>
    </div>
  );
}
