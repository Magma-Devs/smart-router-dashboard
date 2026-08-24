"use client";

import { useEffect, useMemo, useState } from "react";
import type { VendorStatus, VendorStatusReport } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { resolveConfig } from "@/lib/api-client";

/* Build-time fallback for the index's own site, used until the runtime config
   resolves (and if it never does). The runtime value comes from
   DASHBOARD_SPI_URL via /api/config, the same mechanism the Grafana link uses,
   so one published web image can point at any index. */
const BUILD_SPI_URL = process.env.NEXT_PUBLIC_SPI_URL ?? "https://providers-status.magmadevs.com";

export interface VendorStatusIndex {
  /** Null when the api has nothing to serve — the index has never answered, or
   *  vendor status is switched off. The honest empty state: no chip, no
   *  banner, nothing invented. `[]` means "the index knows no vendors". */
  vendors: VendorStatus[] | null;
  /** Slug → vendor. Index slugs ARE the upstream catalog ids, so a card looks
   *  itself up by `catalogId`. Empty whenever `vendors` is null. */
  bySlug: Map<string, VendorStatus>;
  /** When the data being served was read (ISO-8601), null before the first. */
  fetchedAt: string | null;
  /** The api is serving its last good read because the index is unreachable
   *  right now — a caveat on the data, never a reason to hide it. */
  stale: boolean;
  /** `STATUS_PAGE_INDEX_URL` is empty: the feature is off for this deployment. */
  disabled: boolean;
}

/**
 * Vendor status for every upstream vendor the index tracks, with a verdict per
 * chain this deployment routes through them. Polls at the cadence the api
 * caches at — a faster poll would only re-serve the same cached minute.
 */
export function useVendorStatus(): VendorStatusIndex {
  const { data } = useApi<VendorStatusReport>("/api/vendors/status", 60000);
  const vendors = data?.vendors ?? null;
  const bySlug = useMemo(() => {
    const map = new Map<string, VendorStatus>();
    for (const vendor of vendors ?? []) map.set(vendor.slug, vendor);
    return map;
  }, [vendors]);
  return {
    vendors,
    bySlug,
    fetchedAt: data?.fetchedAt ?? null,
    stale: data?.stale ?? false,
    disabled: data?.disabled ?? false,
  };
}

/**
 * The index's own site, for links out to a vendor's full history. Taken from
 * the runtime config the api client already resolves ONCE per session: a fetch
 * per chip meant a dozen identical `/api/config` requests every time the
 * Upstreams page rendered.
 */
export function useSpiUrl(): string {
  const [url, setUrl] = useState(BUILD_SPI_URL);
  useEffect(() => {
    let alive = true;
    void resolveConfig().then((cfg) => {
      if (alive && cfg.spiUrl) setUrl(cfg.spiUrl);
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
