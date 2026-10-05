import { blur, colors, layout, motion, radii, shadows, space, typography } from "./tokens.js";

/** Flat map of CSS custom properties for injecting into :root. */
export function buildCssVars(): Record<string, string> {
  return {
    "--cal-color-abyss": colors.abyss,
    "--cal-color-deep": colors.deep,
    "--cal-color-surface": colors.surface,
    "--cal-color-raised": colors.raised,
    "--cal-color-overlay": colors.overlay,
    "--cal-color-glass": colors.glass,

    "--cal-color-border": colors.border,
    "--cal-color-border-strong": colors.borderStrong,
    "--cal-color-border-focus": colors.borderFocus,

    "--cal-color-text": colors.textPrimary,
    "--cal-color-text-secondary": colors.textSecondary,
    "--cal-color-text-muted": colors.textMuted,
    "--cal-color-text-inverse": colors.textInverse,

    "--cal-color-accent": colors.accent,
    "--cal-color-accent-soft": colors.accentSoft,
    "--cal-color-accent-hover": colors.accentHover,
    "--cal-color-accent-pressed": colors.accentPressed,
    "--cal-color-violet": colors.violet,
    "--cal-color-violet-soft": colors.violetSoft,
    "--cal-color-coral": colors.coral,
    "--cal-color-gold": colors.gold,

    "--cal-color-success": colors.success,
    "--cal-color-warning": colors.warning,
    "--cal-color-danger": colors.danger,
    "--cal-color-info": colors.info,

    "--cal-font-sans": typography.fontSans,
    "--cal-font-mono": typography.fontMono,
    "--cal-font-display": typography.fontDisplay,

    "--cal-radius-sm": radii.sm,
    "--cal-radius-md": radii.md,
    "--cal-radius-lg": radii.lg,
    "--cal-radius-xl": radii.xl,
    "--cal-radius-2xl": radii["2xl"],
    "--cal-radius-pill": radii.pill,

    "--cal-shadow-sm": shadows.sm,
    "--cal-shadow-md": shadows.md,
    "--cal-shadow-lg": shadows.lg,
    "--cal-shadow-glow": shadows.glow,
    "--cal-shadow-focus": shadows.focus,

    "--cal-space-1": space[1],
    "--cal-space-2": space[2],
    "--cal-space-3": space[3],
    "--cal-space-4": space[4],
    "--cal-space-5": space[5],
    "--cal-space-6": space[6],
    "--cal-space-8": space[8],
    "--cal-space-10": space[10],
    "--cal-space-12": space[12],

    "--cal-duration-fast": motion.duration.fast,
    "--cal-duration-normal": motion.duration.normal,
    "--cal-duration-slow": motion.duration.slow,
    "--cal-ease-standard": motion.easing.standard,
    "--cal-ease-entrance": motion.easing.entrance,

    "--cal-sidebar-width": layout.sidebarWidth,
    "--cal-sidebar-collapsed": layout.sidebarCollapsed,
    "--cal-titlebar-height": layout.titlebarHeight,
    "--cal-max-content": layout.maxContentWidth,

    "--cal-blur-sm": blur.sm,
    "--cal-blur-md": blur.md,
    "--cal-blur-lg": blur.lg,
  };
}

export function cssVarsToString(vars: Record<string, string> = buildCssVars()): string {
  return Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
}
