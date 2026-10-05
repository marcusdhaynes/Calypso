import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "./Button.js";
import { colors, radii, space } from "../theme/tokens.js";

export interface ChatComposerProps {
  placeholder?: string;
  disabled?: boolean;
  /** Seed text from outside (e.g. voice transcript). */
  value?: string;
  onChange?: (text: string) => void;
  onSend: (text: string) => void;
  /** Enable hold-to-talk mic (Web Speech API when available). */
  enableVoice?: boolean;
  onVoiceError?: (message: string) => void;
}

type SpeechRec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognition(): (new () => SpeechRec) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function ChatComposer({
  placeholder = "Message Calypso…",
  disabled,
  value: controlled,
  onChange,
  onSend,
  enableVoice = true,
  onVoiceError,
}: ChatComposerProps) {
  const [internal, setInternal] = useState("");
  const value = controlled ?? internal;
  const setValue = (next: string) => {
    if (controlled === undefined) setInternal(next);
    onChange?.(next);
  };

  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRec | null>(null);
  const baseBeforeVoice = useRef("");

  useEffect(() => {
    return () => {
      try {
        recRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, []);

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

  const stopVoice = () => {
    const rec = recRef.current;
    recRef.current = null;
    setListening(false);
    if (!rec) return;
    try {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.stop();
    } catch {
      /* ignore */
    }
  };

  const startVoice = () => {
    if (disabled || listening) return;
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      onVoiceError?.("Speech recognition isn’t available in this build — type instead.");
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    baseBeforeVoice.current = value.trim() ? `${value.trim()} ` : "";
    rec.onresult = (ev) => {
      let interim = "";
      let finalText = "";
      for (let i = 0; i < ev.results.length; i++) {
        const piece = ev.results[i]![0]!.transcript;
        if (ev.results[i]!.isFinal) finalText += piece;
        else interim += piece;
      }
      setValue(`${baseBeforeVoice.current}${finalText}${interim}`.trimStart());
    };
    rec.onerror = (ev) => {
      if (ev.error !== "aborted" && ev.error !== "no-speech") {
        onVoiceError?.(`Voice error: ${ev.error}`);
      }
      stopVoice();
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      onVoiceError?.(err instanceof Error ? err.message : "Could not start microphone.");
      setListening(false);
      recRef.current = null;
    }
  };

  const onMicDown = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    startVoice();
  };

  const onMicUp = () => stopVoice();

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
      {enableVoice ? (
        <Button
          type="button"
          size="md"
          variant={listening ? "primary" : "ghost"}
          onPointerDown={onMicDown}
          onPointerUp={onMicUp}
          onPointerCancel={onMicUp}
          onLostPointerCapture={onMicUp}
          aria-label={listening ? "Release to stop talking" : "Hold to talk"}
          aria-pressed={listening}
          data-testid="chat-ptt"
          disabled={disabled}
          title="Hold to talk"
        >
          {listening ? "Listening…" : "Hold"}
        </Button>
      ) : null}
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={listening ? "Listening…" : placeholder}
        disabled={disabled}
        rows={1}
        className="cal-focus-ring"
        aria-label="Message"
        style={{
          flex: 1,
          resize: "none",
          minHeight: 44,
          maxHeight: 160,
          padding: `${space[6]} ${space[8]}`,
          borderRadius: radii.lg,
          border: `1px solid ${listening ? colors.accent : colors.borderStrong}`,
          background: colors.surface,
          color: colors.textPrimary,
          outline: "none",
          lineHeight: 1.45,
        }}
      />
      <Button type="submit" variant="primary" size="md" disabled={disabled || !value.trim()} aria-label="Send">
        Send
      </Button>
    </form>
  );
}
