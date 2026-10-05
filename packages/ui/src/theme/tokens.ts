/**
 * Calypso design tokens — single source of visual truth.
 * Dark-mode first. Ocean palette: deep abyss, teal lagoon, soft phosphorescence.
 * Keep CSS vars in sync via `cssVars` / `global.css`.
 */

export const colors = {
  // Surfaces (layered depth)
  abyss: "#07090D",
  deep: "#0C1017",
  surface: "#121821",
  raised: "#181F2B",
  overlay: "#1E2736",
  glass: "rgba(18, 24, 33, 0.72)",

  // Borders / hairlines
  border: "rgba(255, 255, 255, 0.06)",
  borderStrong: "rgba(255, 255, 255, 0.12)",
  borderFocus: "rgba(56, 210, 193, 0.55)",

  // Text
  textPrimary: "#F2F5F9",
  textSecondary: "#9AA6B8",
  textMuted: "#657286",
  textInverse: "#07090D",

  // Brand / accent (Calypso lagoon)
  accent: "#38D2C1",
  accentSoft: "rgba(56, 210, 193, 0.14)",
  accentHover: "#4FE0D0",
  accentPressed: "#2BB8A8",
  violet: "#8B7CFF",
  violetSoft: "rgba(139, 124, 255, 0.14)",
  coral: "#FF7A6E",
  gold: "#F0C25A",

  // Semantic
  success: "#3DD68C",
  warning: "#F0C25A",
  danger: "#FF6B7A",
  info: "#5BA8FF",

  // Gradients (use as CSS background values)
  glowAccent: "radial-gradient(120% 80% at 50% 0%, rgba(56, 210, 193, 0.18), transparent 60%)",
  glowViolet: "radial-gradient(100% 70% at 80% 10%, rgba(139, 124, 255, 0.16), transparent 55%)",
  sidebarWash: "linear-gradient(180deg, #0C1017 0%, #0A0E14 100%)",
} as const;

export const typography = {
  fontSans:
    '"Inter", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  fontMono: '"JetBrains Mono", "Cascadia Code", "Consolas", ui-monospace, monospace',
  fontDisplay: '"Inter", "Segoe UI", system-ui, sans-serif',

  size: {
    xs: "11px",
    sm: "12px",
    md: "13.5px",
    base: "14.5px",
    lg: "16px",
    xl: "18px",
    "2xl": "22px",
    "3xl": "28px",
    "4xl": "36px",
  },

  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },

  lineHeight: {
    tight: 1.2,
    snug: 1.35,
    normal: 1.5,
    relaxed: 1.65,
  },

  tracking: {
    tight: "-0.02em",
    normal: "-0.01em",
    wide: "0.04em",
  },
} as const;

export const space = {
  0: "0",
  1: "2px",
  2: "4px",
  3: "6px",
  4: "8px",
  5: "10px",
  6: "12px",
  7: "14px",
  8: "16px",
  9: "20px",
  10: "24px",
  12: "32px",
  14: "40px",
  16: "48px",
  20: "64px",
  24: "80px",
} as const;

export const radii = {
  none: "0",
  sm: "6px",
  md: "10px",
  lg: "14px",
  xl: "18px",
  "2xl": "24px",
  pill: "999px",
  full: "50%",
} as const;

export const shadows = {
  sm: "0 1px 2px rgba(0, 0, 0, 0.35)",
  md: "0 4px 16px rgba(0, 0, 0, 0.4)",
  lg: "0 12px 40px rgba(0, 0, 0, 0.5)",
  glow: "0 0 24px rgba(56, 210, 193, 0.22)",
  focus: "0 0 0 3px rgba(56, 210, 193, 0.28)",
  inset: "inset 0 1px 0 rgba(255, 255, 255, 0.04)",
} as const;

export const motion = {
  duration: {
    instant: "60ms",
    fast: "120ms",
    normal: "200ms",
    slow: "320ms",
    slower: "480ms",
  },
  easing: {
    standard: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    entrance: "cubic-bezier(0.16, 1, 0.3, 1)",
    exit: "cubic-bezier(0.4, 0, 1, 1)",
    spring: "cubic-bezier(0.34, 1.2, 0.64, 1)",
  },
} as const;

export const layout = {
  sidebarWidth: "260px",
  sidebarCollapsed: "68px",
  titlebarHeight: "40px",
  composerMinHeight: "56px",
  workerRailWidth: "280px",
  maxContentWidth: "820px",
  z: {
    base: 0,
    raised: 10,
    dropdown: 100,
    sticky: 200,
    modal: 300,
    toast: 400,
    overlay: 500,
  },
} as const;

export const blur = {
  sm: "8px",
  md: "16px",
  lg: "24px",
} as const;

export type ColorToken = keyof typeof colors;
export type SpaceToken = keyof typeof space;
