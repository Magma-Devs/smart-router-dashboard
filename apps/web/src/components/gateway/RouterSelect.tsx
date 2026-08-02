"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";

/* Router scope dropdown — restricts every metrics panel to ONE router
   deployment. Styled after WindowSelect (themed popover, click-outside).

   The router labels its series with the CHAIN, so several routers serving the
   same chain (a staging + production pair, say) sum into one set of numbers;
   scoping re-splits them on the collector's per-target label. The values are
   whatever that label carries — Service names like `eth-mainnet-router` — so
   they are shown verbatim, matching what kubectl shows.

   Renders NOTHING when the api reports fewer than two routers: with one (or
   none, when the collector attaches no such label) there is nothing to split,
   and a filter that can't change anything is worse than no filter. */

interface RoutersResponse {
  label: string;
  routers: string[];
}

export function RouterSelect() {
  const { router, setRouter } = useFilters();
  const { data } = useApi<RoutersResponse>("/api/metrics/routers", 300000);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  // Memoized: a fresh [] each render would re-fire the stale-selection effect.
  const routers = useMemo(() => data?.routers ?? [], [data]);

  // A stale selection (a router that has since gone away) would silently
  // filter every panel down to nothing — drop back to "All routers".
  useEffect(() => {
    if (router && data && !routers.includes(router)) setRouter(null);
  }, [router, data, routers, setRouter]);

  if (routers.length < 2) return null;

  const options: (string | null)[] = [null, ...routers];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={`Scope every metric to one router (Prometheus label: ${data?.label ?? "service"})`}
        style={{
          height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line-2)",
          background: "var(--surface)", color: "var(--text)", fontSize: 12, fontFamily: "inherit",
          cursor: "pointer", display: "flex", alignItems: "center", gap: 8, maxWidth: 240,
          justifyContent: "space-between",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" /></svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {router ?? "All routers"}
          </span>
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 120, minWidth: 220, padding: 4, borderRadius: 9, background: "var(--surface-2)", border: "1px solid var(--line-2)", boxShadow: "0 10px 30px rgba(0,0,0,0.5)", maxHeight: 320, overflowY: "auto" }}>
          {options.map((value) => (
            <button
              key={value ?? "__all"}
              onClick={() => { setRouter(value); setOpen(false); }}
              className={value === null ? undefined : "gw-mono"}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                borderRadius: 6, border: "none",
                background: router === value ? "var(--hover)" : "transparent",
                color: router === value ? "var(--text)" : "var(--text-2)",
                fontSize: value === null ? 12 : 11, fontWeight: router === value ? 600 : 400,
                fontFamily: value === null ? "inherit" : undefined,
                cursor: "pointer", textAlign: "left",
              }}
            >
              {value ?? "All routers"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
