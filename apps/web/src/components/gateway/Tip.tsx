"use client";

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/* The (i) beside a label, and the card it opens. The card points at its (i)
 * with an arrow, opens below it - above when there's no room - and never
 * past a screen edge; it is portalled to <body>, so no transformed ancestor
 * can move it. A tip with no text draws no (i): an icon that opens nothing is
 * worse than none. */

/** `**bold**` and `*italic*` inside one line. */
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(m[1] != null
      ? <strong key={k++} style={{ color: "var(--text)", fontWeight: 600 }}>{m[1]}</strong>
      : <em key={k++} style={{ color: "var(--text)", fontStyle: "italic" }}>{m[2]}</em>);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/**
 * Tooltip text → blocks. A blank line starts a paragraph; the first one is
 * the lead, in the brighter text colour, so the one-line answer stands out
 * from the detail under it. Lines that all start with "- " are a list.
 */
export function renderTipText(text: string): ReactNode {
  if (typeof text !== "string") return text;
  // Long dashes read as a regular one: the house style never uses them.
  return text.replace(/\\n/g, "\n").replace(/[\u2014\u2013]/g, "-").split(/\n{2,}/).map((para, pi) => {
    const lines = para.split("\n").filter((l) => l.trim());
    const gap = pi ? 9 : 0;
    if (lines.length && lines.every((l) => /^\s*[-•]\s+/.test(l))) {
      return (
        <ul key={pi} style={{ listStyle: "none", margin: `${gap}px 0 0`, padding: 0, display: "grid", gap: 5 }}>
          {lines.map((l, li) => (
            <li key={li} style={{ display: "flex", gap: 8 }}>
              <span aria-hidden style={{ width: 4, height: 4, borderRadius: 2, background: "var(--text-4)", flexShrink: 0, marginTop: 7 }} />
              <span>{inline(l.replace(/^\s*[-•]\s+/, ""))}</span>
            </li>
          ))}
        </ul>
      );
    }
    return (
      <p key={pi} style={{ margin: `${gap}px 0 0`, color: pi === 0 ? "var(--text)" : "var(--text-2)" }}>
        {lines.map((l, li) => <Fragment key={li}>{li > 0 && <br />}{inline(l)}</Fragment>)}
      </p>
    );
  });
}

/** The arrow's size and the space between it and the (i). */
const ARROW = 6;
const GAP = 4;

export function Tip({ text }: { text: string | null | undefined }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const icon = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLSpanElement>(null);
  const id = useId();

  const open = () => {
    const r = icon.current?.getBoundingClientRect();
    if (r) setAnchor(r);
  };
  const close = () => setAnchor(null);

  /* Place the card once it has a size - straight on the DOM, so it appears
     in the right place on its first paint rather than jumping there. */
  useLayoutEffect(() => {
    const el = card.current;
    if (!anchor || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const cx = anchor.left + anchor.width / 2;
    const left = Math.min(Math.max(cx - w / 2, 8), window.innerWidth - w - 8);
    const below = anchor.bottom + ARROW + GAP;
    const above = below + h > window.innerHeight - 8 && anchor.top - ARROW - GAP - h >= 8;
    el.style.left = `${left}px`;
    el.style.top = `${above ? anchor.top - ARROW - GAP - h : below}px`;
    el.style.visibility = "visible";
    const a = arrow.current;
    if (a) {
      a.style.left = `${Math.min(Math.max(cx - left - ARROW, 10), w - 10 - 2 * ARROW)}px`;
      a.style.top = above ? "" : `${-ARROW - 1}px`;
      a.style.bottom = above ? `${-ARROW - 1}px` : "";
      a.style.transform = above ? "rotate(225deg)" : "rotate(45deg)";
    }
  }, [anchor]);

  // A scroll moves the (i) out from under a card that stays put: close it.
  useEffect(() => {
    if (!anchor) return;
    const onScroll = () => setAnchor(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [anchor]);

  if (!text || !text.trim()) return null;

  return (
    <span style={{ position: "relative", display: "inline-flex", verticalAlign: "middle" }}
      onMouseEnter={open} onMouseLeave={close}>
      <span ref={icon} tabIndex={0} role="button" aria-label="More about this" aria-describedby={anchor ? id : undefined}
        onFocus={open} onBlur={close}
        style={{
          width: 14, height: 14, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontSize: 9, lineHeight: 1, fontFamily: "var(--font-ui)", flexShrink: 0, marginLeft: 4, cursor: "help", outline: "none",
          background: anchor ? "var(--surface-2)" : "var(--bg-2)",
          border: `1px solid ${anchor ? "var(--text-4)" : "var(--line-2)"}`,
          color: anchor ? "var(--text)" : "var(--text-3)",
          transition: "color 0.12s, border-color 0.12s, background 0.12s",
        }}>i</span>
      {anchor && typeof document !== "undefined" && createPortal(
        <div ref={card} id={id} role="tooltip"
          style={{
            position: "fixed", left: 0, top: 0, visibility: "hidden", zIndex: 9999, pointerEvents: "none",
            width: "max-content", maxWidth: 320, padding: "11px 14px 12px", borderRadius: 10,
            background: "var(--surface-2)", border: "1px solid var(--line-2)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
            fontSize: 12, fontWeight: 400, lineHeight: 1.55, letterSpacing: "normal", textTransform: "none",
            textAlign: "left", whiteSpace: "normal", fontFamily: "var(--font-ui)", color: "var(--text-2)",
          }}>
          {/* the arrow: a square turned 45°, bordered on the two sides that face out */}
          <span ref={arrow} aria-hidden style={{
            position: "absolute", width: ARROW * 2, height: ARROW * 2, background: "var(--surface-2)",
            borderLeft: "1px solid var(--line-2)", borderTop: "1px solid var(--line-2)",
          }} />
          {renderTipText(text)}
        </div>,
        document.body,
      )}
    </span>
  );
}
