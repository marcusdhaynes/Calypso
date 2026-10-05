import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { colors, motion, radii, shadows } from "../theme/tokens.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
}

const sizeStyles: Record<ButtonSize, CSSProperties> = {
  sm: { height: 28, padding: "0 10px", fontSize: 12, gap: 6 },
  md: { height: 34, padding: "0 14px", fontSize: 13.5, gap: 8 },
  lg: { height: 40, padding: "0 18px", fontSize: 14.5, gap: 8 },
};

function variantStyle(variant: ButtonVariant, disabled?: boolean): CSSProperties {
  const base: CSSProperties = {
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
  switch (variant) {
    case "primary":
      return {
        ...base,
        background: `linear-gradient(180deg, ${colors.accentHover} 0%, ${colors.accent} 100%)`,
        color: colors.textInverse,
        boxShadow: `${shadows.sm}, ${shadows.inset}`,
        fontWeight: 600,
      };
    case "secondary":
      return {
        ...base,
        background: colors.raised,
        color: colors.textPrimary,
        border: `1px solid ${colors.borderStrong}`,
        boxShadow: shadows.inset,
        fontWeight: 500,
      };
    case "ghost":
      return {
        ...base,
        background: "transparent",
        color: colors.textSecondary,
        fontWeight: 500,
      };
    case "danger":
      return {
        ...base,
        background: "rgba(255, 107, 122, 0.14)",
        color: colors.danger,
        border: "1px solid rgba(255, 107, 122, 0.28)",
        fontWeight: 600,
      };
  }
}

export function Button({
  variant = "secondary",
  size = "md",
  leading,
  trailing,
  children,
  disabled,
  style,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={["cal-focus-ring", className].filter(Boolean).join(" ")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radii.md,
        transition: `background ${motion.duration.fast} ${motion.easing.standard}, color ${motion.duration.fast} ${motion.easing.standard}, border-color ${motion.duration.fast} ${motion.easing.standard}, transform ${motion.duration.fast} ${motion.easing.standard}`,
        ...sizeStyles[size],
        ...variantStyle(variant, disabled),
        ...style,
      }}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </button>
  );
}
