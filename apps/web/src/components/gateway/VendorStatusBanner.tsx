"use client";

/* Global vendor-incident banner. Sits above every page's content because an
 * upstream vendor's outage explains what you are about to look at, whichever
 * screen you happen to be on.
 *
 * Three rules keep it from becoming wallpaper:
 *  - it names only vendors PRESENT in this deployment's topology (a catalog id
 *    the mounted values file actually matched) — someone else's outage is not
 *    news here;
 *  - it fires only on a reported problem (degraded / outage). "Their page
 *    can't be read" and "the index probes nothing here" are the normal state
 *    of half the catalog and say nothing;
 *  - it is dismissable per vendor AND per state, so waving one away doesn't
 *    hide the same vendor getting worse. Dismissals live in sessionStorage:
 *    a new tab, a new day, a fresh warning. */

import { useCallback, useMemo, useState } from "react";
import type { RouterTopology, VendorStatus } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { buildUpstreamRows } from "@/components/upstreams/catalog";
import { useVendorStatus } from "@/hooks/use-vendor-status";
import {
  affectedVendors,
  measuredStatusLabel,
  officialStatusLabel,
  officialSeverity,
  vendorBannerKey,
  vendorSeverity,
} from "@/lib/vendor-status";

const DISMISSED_KEY = "sr:vendor-status-dismissed";

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

/** What the vendor is actually reporting — their page's word when that is the
 *  problem, the index's own probes when it isn't. Never both mashed into one
 *  claim: they are different observers. */
function bannerMessage(vendor: VendorStatus): string {
  const official = officialSeverity(vendor.official.status);
  const lead =
    official === "degraded" || official === "outage"
      ? `${vendor.name} is reporting ${officialStatusLabel(vendor.official.status).toLowerCase()} on their own status page`
      : `The status index measures ${vendor.name} as ${measuredStatusLabel(vendor.measuredStatus).toLowerCase()}`;
  return `${lead} — upstream trouble on this chain is likely their side, not this deployment.`;
}

export function VendorStatusBanner() {
  const { vendors } = useVendorStatus();
  // Same SWR key as the Upstreams page, so this costs no extra request.
  const config = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);

  const presentSlugs = useMemo(() => {
    const slugs = new Set<string>();
    for (const upstream of buildUpstreamRows(config.data?.routers ?? [], undefined)) {
      if (upstream.catalogId !== null) slugs.add(upstream.catalogId);
    }
    return slugs;
  }, [config.data]);

  const showing = useMemo(
    () => affectedVendors(vendors, presentSlugs).filter((v) => !dismissed.includes(vendorBannerKey(v))),
    [vendors, presentSlugs, dismissed],
  );

  const dismiss = useCallback((vendor: VendorStatus) => {
    const key = vendorBannerKey(vendor);
    setDismissed((prev) => {
      const next = prev.includes(key) ? prev : [...prev, key];
      try {
        sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      } catch {
        /* private mode / storage full — the banner just returns next reload */
      }
      return next;
    });
  }, []);

  if (showing.length === 0) return null;

  return (
    <div style={{ padding: "14px 40px 0", maxWidth: 1320, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
      {showing.map((vendor) => {
        const outage = vendorSeverity(vendor) === "outage";
        const accent = outage ? "var(--err)" : "var(--warn)";
        const background = outage ? "rgba(239,68,68,0.06)" : "rgba(245,158,11,0.06)";
        const border = outage ? "rgba(239,68,68,0.22)" : "rgba(245,158,11,0.22)";
        return (
          <div
            key={vendor.slug}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderRadius: 8, background, border: `1px solid ${border}`, fontSize: 12.5 }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span style={{ flex: 1, minWidth: 0 }}>{bannerMessage(vendor)}</span>
            {vendor.statusPage && (
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
              aria-label={`Dismiss the ${vendor.name} status notice`}
              onClick={() => dismiss(vendor)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
