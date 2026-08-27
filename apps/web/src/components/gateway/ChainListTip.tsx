"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildChainMetaByIndex } from "@sr/shared";
import { ChainBadge } from "@/components/gateway/ChainBadge";

/* Hover/focus panel listing the chains behind a summarised count.
 *
 * The Upstreams roster names ONE chain per upstream card and summarises the
 * rest as "+26" — which is only honest if the 26 are reachable. This is that
 * affordance: it wraps the count itself (not a separate "i" dot, the way
 * `<Tip>` does) so the thing that says there are more is the thing you hover.
 *
 * Positioning is `<Tip>`'s — a panel fixed to the viewport, centred on the
 * target and clamped to stay on screen, `pointerEvents: none` so it can never
 * eat a click — but rendered through a PORTAL to `document.body`, which
 * `<Tip>` does not do. `.gw-page` carries `.fade-in`, whose `both` fill leaves
 * a `transform` animation permanently in effect, and an element with a
 * transform in effect is the containing block for its `position: fixed`
 * descendants. Positioned in place, the panel resolves its coordinates
 * against the page instead of the viewport: correct at scroll 0, and drifting
 * off the top of the screen by exactly the scroll offset after that. The
 * portal is what makes `fixed` mean the viewport again.
 *
 * The list is capped — a panel that scrolls would need pointer events, and
 * the card's own rows already spell out every chain underneath. */

/** Chains past this are summarised rather than listed (see CAP note above). */
const MAX_LISTED = 40;
/** Two columns once the single column would get tall. */
const TWO_COL_FROM = 9;

export function ChainListTip({
  chains,
  children,
}: {
  /** Lava spec indexes — `ETH1`, `COSMOSHUB`, … */
  chains: string[];
  /** The hover target (the count chip). */
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const listed = chains.slice(0, MAX_LISTED);
  const hidden = chains.length - listed.length;
  const cols = listed.length >= TWO_COL_FROM ? 2 : 1;
  const width = cols === 2 ? 340 : 200;

  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // Height estimate (header + rows + padding) — enough to keep a long list
    // on screen without measuring after paint.
    const est = 34 + Math.ceil(listed.length / cols) * 20 + (hidden > 0 ? 20 : 0) + 20;
    const half = width / 2 + 8;
    setPos({
      x: Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half),
      y: Math.max(8, Math.min(r.bottom + 7, window.innerHeight - est - 8)),
    });
  };
  const close = () => setPos(null);

  return (
    <span
      ref={ref}
      tabIndex={0}
      // Keyboard users get the same list — the count is the only place the
      // other chains are named at card level.
      aria-label={`${chains.length} chains: ${listed.map((s) => buildChainMetaByIndex(s).name).join(", ")}${hidden > 0 ? `, and ${hidden} more` : ""}`}
      style={{ position: "relative", display: "inline-flex", verticalAlign: "middle", cursor: "help", borderRadius: 4, outlineOffset: 2 }}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {children}
      {pos && createPortal(
        <span
          role="tooltip"
          style={{
            position: "fixed", top: pos.y, left: pos.x, transform: "translateX(-50%)",
            zIndex: 9999, width, padding: "10px 12px", borderRadius: 8,
            background: "var(--surface-2)", border: "1px solid var(--line-2)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)", pointerEvents: "none",
            textAlign: "left", letterSpacing: "normal", textTransform: "none",
          }}
        >
          <span style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
            {chains.length} chain{chains.length !== 1 ? "s" : ""}
          </span>
          <span style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: "4px 12px" }}>
            {listed.map((spec) => (
              <span key={spec} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <ChainBadge spec={spec} size={13} />
                <span style={{ fontSize: 11, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {buildChainMetaByIndex(spec).name}
                </span>
              </span>
            ))}
          </span>
          {hidden > 0 && (
            <span style={{ display: "block", fontSize: 10, color: "var(--text-3)", marginTop: 8 }}>
              +{hidden} more — listed in the rows below
            </span>
          )}
        </span>,
        document.body,
      )}
    </span>
  );
}
