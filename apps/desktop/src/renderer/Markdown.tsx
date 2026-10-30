import { Fragment, type ReactNode } from "react";

/**
 * Small, dependency-free Markdown renderer for chat replies.
 * Builds React elements directly (no innerHTML), so model output can't inject markup.
 * Covers what local models actually emit: headings, bold/italic, inline code,
 * fenced code blocks, bullet and numbered lists, quotes, rules, links, and line breaks.
 */

const mono = "ui-monospace, SFMono-Regular, Consolas, 'Cascadia Code', monospace";

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // order matters: code first so ** inside code is literal
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (m[1]) {
      out.push(
        <code key={k} style={{ fontFamily: mono, fontSize: "0.9em", background: "rgba(255,255,255,0.07)", padding: "1px 5px", borderRadius: 4 }}>
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (m[2] || m[3]) {
      out.push(<strong key={k}>{renderInline(tok.slice(2, -2), k)}</strong>);
    } else if (m[4]) {
      out.push(<em key={k}>{renderInline(tok.slice(1, -1), k)}</em>);
    } else if (m[5]) {
      const label = tok.slice(1, tok.indexOf("]("));
      const href = m[6];
      out.push(
        <a key={k} href={href} target="_blank" rel="noreferrer" style={{ color: "#38d2c1" }}>
          {label}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul" | "ol"; items: string[]; start: number }
  | { kind: "code"; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" };

/** Some models collapse lists onto one line ("### A 1. x 2. y"); split those back out. */
function normalize(src: string): string {
  let s = src.replace(/\r\n/g, "\n");
  if (!s.includes("\n") && s.length > 160) {
    s = s
      .replace(/\s+(#{1,6}\s)/g, "\n\n$1")
      .replace(/\s+(\d{1,2}\.\s+\*\*)/g, "\n$1")
      .replace(/\s+(-\s+\*\*)/g, "\n$1");
    // heading text runs until the first list item on that line
    s = s.replace(/^(#{1,6}\s[^\n]*?)\s+(?=(\d{1,2}\.|-)\s)/gm, "$1\n");
  }
  return s;
}

function parse(src: string): Block[] {
  const lines = normalize(src).split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }
    if (t.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) { blocks.push({ kind: "h", level: h[1].length, text: h[2].replace(/\s*#+$/, "") }); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { blocks.push({ kind: "hr" }); i++; continue; }
    if (/^[-*+]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { const raw = lines[i++]; items.push((raw.match(/^\s*/)?.[0] ?? "") + raw.trim().replace(/^[-*+]\s+/, "")); }
      blocks.push({ kind: "ul", items, start: 1 });
      continue;
    }
    const ol = /^(\d+)[.)]\s+/.exec(t);
    if (ol) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { const raw = lines[i++]; items.push((raw.match(/^\s*/)?.[0] ?? "") + raw.trim().replace(/^\d+[.)]\s+/, "")); }
      blocks.push({ kind: "ol", items, start: Number(ol[1]) });
      continue;
    }
    if (t.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) q.push(lines[i++].trim().replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", lines: q });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|[-*+]\s|\d+[.)]\s|>)/.test(lines[i].trim())
    ) para.push(lines[i++].trim());
    blocks.push({ kind: "p", lines: para });
  }
  return blocks;
}

const headingSize = [0, 18, 16.5, 15.5, 15, 14.5, 14.5];

function renderBlocks(blocks: Block[], keyPrefix = "item"): ReactNode[] {
  return blocks.map((b, bi) => {
    const k = keyPrefix + "-" + bi;
    switch (b.kind) {
      case "h":
        return (
          <div key={k} style={{ fontWeight: 650, fontSize: headingSize[b.level], marginTop: bi ? 6 : 0 }}>
            {renderInline(b.text, k)}
          </div>
        );
      case "ul":
      case "ol": {
        const Tag = b.kind;
        return (
          <Tag
            key={k}
            start={b.kind === "ol" ? b.start : undefined}
            style={{ margin: 0, paddingLeft: 32, display: "flex", flexDirection: "column", gap: 5, listStyleType: b.kind === "ol" ? "decimal-leading-zero" : "disc", fontVariantNumeric: "tabular-nums" }}
          >
            {b.items.map((item, ii) => {
              const depth = Math.min(4, Math.floor((item.match(/^\s*/)?.[0].length ?? 0) / 2));
              return <li key={k + "-" + ii} style={{ paddingLeft: 5, marginLeft: depth * 16 }}>{renderInline(item.trim(), k + "-" + ii)}</li>;
            })}
          </Tag>
        );
      }
      case "code":
        return (
          <pre key={k} style={{ margin: 0, fontFamily: mono, fontSize: 12.5, background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "10px 12px", overflowX: "auto", whiteSpace: "pre" }}>
            {b.text}
          </pre>
        );
      case "quote":
        return (
          <div key={k} style={{ borderLeft: "3px solid rgba(56,210,193,0.5)", paddingLeft: 10, opacity: 0.9 }}>
            {b.lines.map((l, li) => <Fragment key={li}>{li ? <br /> : null}{renderInline(l, k + "-" + li)}</Fragment>)}
          </div>
        );
      case "hr":
        return <hr key={k} style={{ border: 0, borderTop: "1px solid rgba(255,255,255,0.1)", margin: "4px 0", width: "100%" }} />;
      default:
        return (
          <p key={k} style={{ margin: 0 }}>
            {b.lines.map((l, li) => <Fragment key={li}>{li ? <br /> : null}{renderInline(l, k + "-" + li)}</Fragment>)}
          </p>
        );
    }
  });
}

type Section = { title: string; level: number; blocks: Block[] };

function sectionsForLongReply(blocks: Block[], length: number): { intro: Block[]; sections: Section[] } | null {
  if (length < 700 && blocks.length < 11) return null;
  const headings = blocks.filter((b) => b.kind === "h");
  const sections: Section[] = [];
  const intro: Block[] = [];
  if (headings.length >= 2) {
    let active: Section | null = null;
    for (const b of blocks) {
      if (b.kind === "h") {
        active = { title: b.text.replace(/^\d{1,2}[.)]\s*/, ""), level: b.level, blocks: [] };
        sections.push(active);
      } else if (active) {
        active.blocks.push(b);
      } else {
        intro.push(b);
      }
    }
  } else if (blocks.length >= 6) {
    intro.push(...blocks.slice(0, 2));
    for (let i = 2; i < blocks.length; i += 4) {
      const group = blocks.slice(i, i + 4);
      const first = group[0];
      const title =
        first.kind === "p" ? first.lines.join(" ") :
        first.kind === "h" ? first.text :
        first.kind === "ul" || first.kind === "ol" ? first.items[0] :
        "Additional Details";
      sections.push({ title: title.replace(/^#{1,6}\s*/, "").slice(0, 72), level: 2, blocks: group });
    }
  }
  return sections.length ? { intro, sections } : null;
}

export function Markdown({ text }: { text: string }) {
  const blocks = parse(text);
  const grouped = sectionsForLongReply(blocks, text.length);
  return (
    <div className="cal-md" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {grouped ? (
        <>
          {renderBlocks(grouped.intro, "intro")}
          {grouped.sections.map((section, i) => (
            <details className="cal-info-section" key={"section-" + i}>
              <summary style={{ paddingLeft: 14 + Math.min(32, Math.max(0, section.level - 1) * 8) }}>
                <span className="cal-section-number">{String(i + 1).padStart(2, "0")}</span>
                <span>{renderInline(section.title, "section-title-" + i)}</span>
              </summary>
              <div className="cal-section-body" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {renderBlocks(section.blocks, "section-" + i)}
              </div>
            </details>
          ))}
        </>
      ) : renderBlocks(blocks)}
    </div>
  );
}
