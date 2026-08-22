"use client";

/* Global vendor-incident banner. Sits above every page's content because an
 * upstream vendor's incident explains what you are about to look at, whichever
 * screen you happen to be on.
 *
 * Four rules keep it from becoming wallpaper:
 *  - it speaks per (vendor, CHAIN). The api only reports chains this
 *    deployment routes through that vendor, and only from the status-page
 *    components covering them — QuickNode's BSC trouble is not an Ethereum
 *    deployment's news, and used to be announced as if it were;
 *  - it fires only on a reported problem (degraded / outage). "Nothing on
 *    their page maps to this chain", "they publish no feed" and planned
 *    maintenance are the normal state of much of the roster and say nothing;
 *  - it is dismissable per vendor, chain AND state, so waving one away can't
 *    hide the same chain getting worse — and a dismissal is dropped once that
 *    chain stops reporting, so the next incident is announced again;
 *  - at most two at a time, with a count for the rest: a stack of banners
 *    pushes the page it is explaining off the screen. */

import { useCallback, useMemo, useState } from "react";
import { buildChainMetaByIndex } from "@sr/shared";
import { useVendorStatus } from "@/hooks/use-vendor-status";
import {
  affectedVendorChains,
  pruneDismissals,
  vendorChainKey,
  vendorStatusLabel,
  type VendorChainVerdict,
} from "@/lib/vendor-status";

const DISMISSED_KEY = "sr:vendor-status-dismissed";
/** More than this and the banners are the page. The rest are counted. */
const MAX_BANNERS = 2;

function readDismissed(): string[] {
  // Server render and the first client render agree on "nothing dismissed",
  // and both draw nothing at all until the status data lands — so reading
  // storage lazily here can't produce a hydration mismatch.
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(keys: string[]): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(keys));
  } catch {
    /* private mode / storage full — the banner just returns next reload */
  }
}

/** What the vendor is reporting, for the chain we route through them. */
function bannerMessage({ vendor, spec, verdict }: VendorChainVerdict): string {
  const chain = buildChainMetaByIndex(spec).name;
  return (
    `${vendor.name} is reporting ${vendorStatusLabel(verdict.status).toLowerCase()} for ${chain} ` +
    `on their own status page — an upstream problem there is likely their side, not this deployment.`
  );
}

export function VendorStatusBanner() {
  const { vendors } = useVendorStatus();
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);

  const affected = useMemo(() => affectedVendorChains(vendors), [vendors]);

  /* A dismissal outlives its incident only until that chain reads clean again:
     the same vendor breaking the same way twice is two pieces of news. The
     pruning is applied to what we RENDER (pure), and written back the next
     time someone dismisses something — storage never decides what is shown. */
  const live = useMemo(() => pruneDismissals(dismissed, vendors), [dismissed, vendors]);

  const showing = affected.filter(
    (v) => !live.includes(vendorChainKey(v.vendor.slug, v.spec, v.verdict.status)),
  );

  const dismiss = useCallback(
    (key: string) => {
      setDismissed((prev) => {
        const pruned = pruneDismissals(prev, vendors);
        if (pruned.includes(key)) return prev;
        const next = [...pruned, key];
        writeDismissed(next);
        return next;
      });
    },
    [vendors],
  );

  if (showing.length === 0) return null;
  const visible = showing.slice(0, MAX_BANNERS);
  const hidden = showing.length - visible.length;

  return (
    <div style={{ padding: "14px 40px 0", maxWidth: 1320, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
      {visible.map((entry) => {
        const { vendor, spec, verdict, severity } = entry;
        const outage = severity === "outage";
        const accent = outage ? "var(--err)" : "var(--warn)";
        const background = outage ? "rgba(239,68,68,0.06)" : "rgba(245,158,11,0.06)";
        const border = outage ? "rgba(239,68,68,0.22)" : "rgba(245,158,11,0.22)";
        return (
          <div
            key={`${vendor.slug}:${spec}`}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderRadius: 8, background, border: `1px solid ${border}`, fontSize: 12.5 }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span style={{ flex: 1, minWidth: 0 }}>{bannerMessage(entry)}</span>
            {vendor.statusPage !== null && (
              <a
                href={vendor.statusPage}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: accent, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 }}
              >
                View status ↗
              </a>
            )}
            <button
              className="gw-btn gw-btn--ghost"
              style={{ padding: "4px 6px", flexShrink: 0 }}
              aria-label={`Dismiss the ${vendor.name} notice for ${buildChainMetaByIndex(spec).name}`}
              onClick={() => dismiss(vendorChainKey(vendor.slug, spec, verdict.status))}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
      {hidden > 0 && (
        <span style={{ fontSize: 11.5, color: "var(--text-3)", paddingLeft: 2 }}>
          +{hidden} more vendor {hidden === 1 ? "chain" : "chains"} reporting issues — see the Upstreams
          page.
        </span>
      )}
    </div>
  );
}
