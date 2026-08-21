"use client";

/* What the VENDOR behind an upstream says about itself, from the Status Page
 * Index (GET /api/vendors/status). Deliberately worded and coloured apart from
 * <HealthTag>: that one is what THIS deployment measured, this one is what the
 * vendor published. When an upstream goes bad, the two together answer the
 * first question asked — "is it them or is it us?". */

import { useState } from "react";
import type { VendorStatus } from "@sr/shared";
import { fmtAgo } from "@/lib/format";
import {
  measuredStatusLabel,
  officialStatusLabel,
  vendorSeverity,
  vendorTagClass,
  vendorUnknownHint,
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

export function VendorStatusChip({ vendor }: { vendor: VendorStatus }) {
  const [open, setOpen] = useState(false);
  const spiBase = useSpiUrl();
  const severity = vendorSeverity(vendor);
  const hint = vendorUnknownHint(vendor.official.status);

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
        Vendor: {officialStatusLabel(vendor.official.status)}
      </span>

      {open && (
        <span
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 60,
            width: "max-content", maxWidth: 290, padding: "10px 12px", borderRadius: 8,
            background: "var(--surface-2)", border: "1px solid var(--line-2)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)", display: "flex",
            flexDirection: "column", gap: 6, fontSize: 11, lineHeight: 1.5,
            color: "var(--text-2)", textAlign: "left", whiteSpace: "normal", fontWeight: 400,
          }}
        >
          <span style={{ color: "var(--text)", fontWeight: 600 }}>
            {vendor.name} — {officialStatusLabel(vendor.official.status)}
          </span>
          {/* The vendor's own summary line, verbatim. Nothing here is derived
              from this deployment's metrics. */}
          {vendor.official.description && <span>{vendor.official.description}</span>}
          {hint && <span style={{ color: "var(--text-3)" }}>{hint}</span>}
          <span style={{ color: "var(--text-3)" }}>
            Index probes: {measuredStatusLabel(vendor.measuredStatus)}
            {" · checked "}
            {fmtAgo(vendor.official.fetchedAt)}
          </span>
          {vendor.paused && (
            <span style={{ color: "var(--text-3)" }}>
              The index has paused its own probes for this vendor.
            </span>
          )}
          <span style={{ display: "flex", gap: 12, flexWrap: "wrap", paddingTop: 2 }}>
            {vendor.statusPage && (
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
