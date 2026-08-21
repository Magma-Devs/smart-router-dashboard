"use client";

import { useEffect, useMemo, useState } from "react";
import type { VendorStatus, VendorStatusReport } from "@sr/shared";
import { useApi } from "@/hooks/use-api";

/* Status Page Index base URL for the "full history" links. Resolved at runtime
   from /api/config (which reads DASHBOARD_SPI_URL from the container env), the
   same mechanism the Grafana link uses, so one published web image can point at
   any index. Falls back to the build-time NEXT_PUBLIC_SPI_URL, then to the
   hosted index. */
const BUILD_SPI_URL = process.env.NEXT_PUBLIC_SPI_URL ?? "https://providers-status.magmadevs.com";

export interface VendorStatusIndex {
  /** Null when the api could not read the index — the honest empty state:
   *  no chip, no banner, nothing invented. `[]` means "it knows no vendors". */
  vendors: VendorStatus[] | null;
  /** Slug → vendor. SPI slugs ARE the upstream catalog ids, so a card looks
   *  itself up by `catalogId`. Empty whenever `vendors` is null. */
  bySlug: Map<string, VendorStatus>;
  /** When the api last called the index (ISO-8601), null before the first read. */
  fetchedAt: string | null;
}

/**
 * Vendor status for every upstream vendor the index tracks. Polls at the
 * cadence the api caches at — a faster poll would only re-serve the same
 * cached minute.
 */
export function useVendorStatus(): VendorStatusIndex {
  const { data } = useApi<VendorStatusReport>("/api/vendors/status", 60000);
  const vendors = data?.vendors ?? null;
  const bySlug = useMemo(() => {
    const map = new Map<string, VendorStatus>();
    for (const vendor of vendors ?? []) map.set(vendor.slug, vendor);
    return map;
  }, [vendors]);
  return { vendors, bySlug, fetchedAt: data?.fetchedAt ?? null };
}

/** The index's own site, for links out to a vendor's full history. */
export function useSpiUrl(): string {
  const [url, setUrl] = useState(BUILD_SPI_URL);
  useEffect(() => {
    let alive = true;
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => {
        if (alive && typeof c?.spiUrl === "string" && c.spiUrl) setUrl(c.spiUrl);
      })
      .catch(() => {
        /* keep the build-time fallback */
      });
    return () => {
      alive = false;
    };
  }, []);
  return url;
}

/** That vendor's page on the status index — its history, per chain. */
export function spiProviderUrl(base: string, slug: string): string {
  return `${base.replace(/\/+$/, "")}/providers/${encodeURIComponent(slug)}`;
}
