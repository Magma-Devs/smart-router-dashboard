"use client";

/* What the PROVIDER behind an upstream says about THE CHAINS THIS CARD SERVES,
 * from the Status Page Index (GET /api/vendors/status).
 *
 * Deliberately worded and coloured apart from <HealthTag>: that one is what
 * this deployment measured, this one is what the provider published. Together
 * they answer the first question an upstream problem raises — "is it them or
 * is it us?".
 *
 * The chip's text, colour and dot all come from the SAME per-chain verdict.
 * They diverged once — colour from the worst of two observers, text from one
 * of them — and produced a red chip reading "Operational". Whatever a second
 * observer has to say belongs in the card.
 *
 * The card is INTERACTIVE: it carries two links, so it has to survive the
 * pointer travelling to them. A plain onMouseLeave closed it the instant the
 * pointer left the chip, which made those links unclickable. */

import { useCallback, useEffect, useRef, useState } from "react";
import { buildChainMetaByIndex, type VendorStatus } from "@sr/shared";
import { fmtAgo } from "@/lib/format";
import {
  vendorChainVerdicts,
  vendorStatusLabel,
  vendorTagClass,
  worstChainVerdict,
  VENDOR_SEVERITY_COLOR,
} from "@/lib/vendor-status";
import { spiProviderUrl, useSpiUrl } from "@/hooks/use-vendor-status";

const LINK_STYLE: React.CSSProperties = {
  color: "var(--brand)",
  textDecoration: "none",
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

/** How long the card survives the pointer leaving both it and the chip. Long
 *  enough to cross the gap between them, short enough not to linger. */
const CLOSE_GRACE_MS = 200;
/** The gap between chip and card, rendered as PADDING on the card's wrapper so
 *  the pointer never crosses dead space (a margin would close the card). */
const BRIDGE_PX = 6;

export function VendorStatusChip({
  vendor,
  specs,
  stale = false,
}: {
  vendor: VendorStatus;
  /** The chains this card serves — the only ones the chip speaks for. */
  specs: string[];
  /** The api is serving its last good read (the index is unreachable now). */
  stale?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spiBase = useSpiUrl();

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  /** Leaving chip or card only ARMS the close; re-entering either disarms it.
   *  Focus moving between the chip and a link inside the card does the same. */
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, CLOSE_GRACE_MS);
  }, [cancelClose]);

  const closeNow = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  // Esc and a click anywhere else dismiss it — a hover card that can only be
  // dismissed by hovering elsewhere is a trap on a touch screen.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNow();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapperRef.current?.contains(target) === true) return;
      closeNow();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, closeNow]);

  const worst = worstChainVerdict(vendor, specs);
  // No verdict for any chain on this card ⇒ no chip. A grey "unknown" chip on
  // a card the api never judged would be furniture, not information.
  if (worst === null) return null;

  const shown = vendorChainVerdicts(vendor).filter((v) => specs.includes(v.spec));
  const severity = worst.severity;

  return (
    <span
      ref={wrapperRef}
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={show}
      onMouseLeave={scheduleClose}
      onFocus={show}
      onBlur={scheduleClose}
    >
      <span
        className={vendorTagClass(severity)}
        tabIndex={0}
        style={{ fontSize: 10, padding: "1px 6px", display: "inline-flex", gap: 5, alignItems: "center", cursor: "help" }}
      >
        <span
          style={{
            width: 6, height: 6, borderRadius: 999, flexShrink: 0,
            background: VENDOR_SEVERITY_COLOR[severity],
          }}
        />
        Provider: {vendorStatusLabel(worst.verdict.status)}
      </span>

      {open && (
        /* The bridge: the gap under the chip is this wrapper's padding, so it
           belongs to the hover area. Anything else — a margin, a `top` offset —
           is dead space that fires mouseleave mid-journey. */
        <span
          style={{ position: "absolute", top: "100%", left: 0, zIndex: 60, paddingTop: BRIDGE_PX }}
          onMouseEnter={show}
        >
          <span
            style={{
              display: "flex", width: "max-content", maxWidth: 320, padding: "10px 12px",
              borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--line-2)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)", flexDirection: "column", gap: 6,
              fontSize: 11, lineHeight: 1.5, color: "var(--text-2)", textAlign: "left",
              whiteSpace: "normal", fontWeight: 400, cursor: "default",
            }}
          >
            <span style={{ color: "var(--text)", fontWeight: 600 }}>
              {vendor.name} — what their status page says
            </span>

            {/* One line per chain this card serves, with the components the
                verdict was taken from. That is the whole point: a provider's
                other chains are not this card's business. */}
            {shown.map(({ spec, verdict, severity: chainSeverity }) => (
              <span key={spec} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span>
                  <span style={{ color: "var(--text)", fontWeight: 600 }}>
                    {buildChainMetaByIndex(spec).name}
                  </span>
                  {": "}
                  <span style={{ color: VENDOR_SEVERITY_COLOR[chainSeverity] }}>
                    {vendorStatusLabel(verdict.status)}
                  </span>
                </span>
                {verdict.components.map((component) => (
                  <span key={component.name} style={{ color: "var(--text-3)", paddingLeft: 8 }}>
                    {component.name} — {vendorStatusLabel(component.status)}
                  </span>
                ))}
                {verdict.reason !== null && (
                  <span style={{ color: "var(--text-3)", paddingLeft: 8 }}>{verdict.reason}</span>
                )}
              </span>
            ))}

            {/* Context, never the verdict: a provider's headline covers every
                chain they sell, most of which this deployment never touches. */}
            <span style={{ color: "var(--text-3)", borderTop: "1px solid var(--line)", paddingTop: 6 }}>
              Their page overall: {vendorStatusLabel(vendor.official.status)}
              {vendor.official.description === null ? "" : ` — ${vendor.official.description}`}
            </span>
            <span style={{ color: "var(--text-3)" }}>
              Read {fmtAgo(vendor.official.fetchedAt)} from the status index.
            </span>
            {stale && (
              <span style={{ color: "var(--text-3)" }}>
                The index is unreachable right now — this is the last good read.
              </span>
            )}
            {vendor.paused && (
              <span style={{ color: "var(--text-3)" }}>
                The index has paused its own checks for this provider.
              </span>
            )}

            <span style={{ display: "flex", gap: 12, flexWrap: "wrap", paddingTop: 2 }}>
              {vendor.statusPage !== null && (
                <a href={vendor.statusPage} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
                  Their status page ↗
                </a>
              )}
              <a
                href={spiProviderUrl(spiBase, vendor.slug)}
                target="_blank"
                rel="noopener noreferrer"
                style={LINK_STYLE}
              >
                Status index ↗
              </a>
            </span>
          </span>
        </span>
      )}
    </span>
  );
}
