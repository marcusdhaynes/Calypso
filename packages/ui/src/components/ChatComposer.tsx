import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "./Button.js";
import { colors, radii, space } from "../theme/tokens.js";

export interface ChatComposerProps {
  placeholder?: string;
  disabled?: boolean;
  onSend: (text: string) => void;
  onMic?: () => void;
}

export function ChatComposer({
  placeholder = "Message Calypso…",
  disabled,
  onSend,
  onMic,
}: ChatComposerProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: space[4],
        padding: space[8],
        borderTop: `1px solid ${colors.border}`,
        background: colors.deep,
      }}
    >
      {onMic ? (
        <Button type="button" size="md" variant="ghost" onClick={onMic} aria-label="Voice" disabled={disabled}>
          Mic
        </Button>
      ) : null}
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="cal-focus-ring"
        style={{
          flex: 1,
          resize: "none",
          minHeight: 44,
          maxHeight: 160,
          padding: `${space[6]} ${space[8]}`,
          borderRadius: radii.lg,
          border: `1px solid ${colors.borderStrong}`,
          background: colors.surface,
          color: colors.textPrimary,
          outline: "none",
          lineHeight: 1.45,
        }}
      />
      <Button type="submit" variant="primary" size="md" disabled={disabled || !value.trim()}>
        Send
      </Button>
    </form>
  );
}
