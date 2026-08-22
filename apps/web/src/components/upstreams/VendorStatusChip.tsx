"use client";

/* What the VENDOR behind an upstream says about THE CHAINS THIS CARD SERVES,
 * from the Status Page Index (GET /api/vendors/status).
 *
 * Deliberately worded and coloured apart from <HealthTag>: that one is what
 * this deployment measured, this one is what the vendor published. Together
 * they answer the first question an upstream problem raises — "is it them or
 * is it us?".
 *
 * The chip's text, colour and dot all come from the SAME per-chain verdict.
 * They diverged once — colour from the worst of two observers, text from one
 * of them — and produced a red chip reading "Operational". Whatever a second
 * observer has to say belongs in the tooltip. */

import { useState } from "react";
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
  const spiBase = useSpiUrl();

  const worst = worstChainVerdict(vendor, specs);
  // No verdict for any chain on this card ⇒ no chip. A grey "unknown" chip on
  // a card the api never judged would be furniture, not information.
  if (worst === null) return null;

  const shown = vendorChainVerdicts(vendor).filter((v) => specs.includes(v.spec));
  const severity = worst.severity;

  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
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
        Vendor: {vendorStatusLabel(worst.verdict.status)}
      </span>

      {open && (
        <span
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 60,
            width: "max-content", maxWidth: 320, padding: "10px 12px", borderRadius: 8,
            background: "var(--surface-2)", border: "1px solid var(--line-2)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)", display: "flex",
            flexDirection: "column", gap: 6, fontSize: 11, lineHeight: 1.5,
            color: "var(--text-2)", textAlign: "left", whiteSpace: "normal", fontWeight: 400,
          }}
        >
          <span style={{ color: "var(--text)", fontWeight: 600 }}>
            {vendor.name} — what their status page says
          </span>

          {/* One line per chain this card serves, with the components the
              verdict was taken from. That is the whole point: a vendor's other
              chains are not this card's business. */}
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

          {/* Context, never the verdict: a vendor's headline covers every chain
              they sell, most of which this deployment never touches. */}
          <span style={{ color: "var(--text-3)", borderTop: "1px solid var(--line)", paddingTop: 6 }}>
            Their page overall: {vendorStatusLabel(vendor.official.status)}
            {vendor.official.description === null ? "" : ` — ${vendor.official.description}`}
          </span>
          <span style={{ color: "var(--text-3)" }}>
            Index probes: {vendorStatusLabel(vendor.measuredStatus)} · read{" "}
            {fmtAgo(vendor.official.fetchedAt)}
          </span>
          {stale && (
            <span style={{ color: "var(--text-3)" }}>
              The index is unreachable right now — this is the last good read.
            </span>
          )}
          {vendor.paused && (
            <span style={{ color: "var(--text-3)" }}>
              The index has paused its own probes for this vendor.
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
      )}
    </span>
  );
}
