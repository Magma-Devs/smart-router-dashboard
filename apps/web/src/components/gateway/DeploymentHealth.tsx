"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { buildChainMetaByIndex, type DeploymentPulse, type HealthState, type ProviderAttention } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "./FiltersProvider";
import { deploymentHealthSummary, topbarFigures } from "@/lib/upstream-presentation";
import { CAUSE_SHORT, healthColor, healthLabel, sinceWords } from "@/lib/health";

/** Where a provider in the list opens: its chain's Upstreams tab, on that provider. */
const providerHref = (p: ProviderAttention) =>
  `/metrics?chain=${encodeURIComponent(p.spec)}&tab=upstreams&upstream=${encodeURIComponent(p.endpointId)}`;

/**
 * A plain click on a provider's link while its page is the one open: the URL
 * is pushed here and the page told to read it. The page reads its URL when it
 * opens and on Back/Forward (`useScopeInUrl`), and a link to the page it is
 * on opens nothing. From another page, and for a new tab or window, the link
 * is followed. True when the click was handled here.
 */
export function openOnThisPage(
  e: Pick<React.MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "preventDefault">,
  href: string,
  pathname: string | null,
  win: { history: Pick<History, "pushState">; dispatchEvent: (event: Event) => boolean } = window,
): boolean {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if (pathname !== href.split("?")[0]) return false;
  e.preventDefault();
  win.history.pushState(null, "", href);
  win.dispatchEvent(new Event("popstate"));
  return true;
}

/**
 * The top bar's word on the deployment, drawn only when something needs a
 * look: the router itself, or providers that are unhealthy or have no data.
 * While all is well it draws nothing. Clicking it lists those providers -
 * which, on which chain, why, and since when - each a link to its page.
 */
export function DeploymentHealthBadge({
  health,
  counts,
  attention = [],
  loading = false,
  error = false,
}: {
  health: HealthState | undefined;
  counts: DeploymentPulse["upstreamHealthCounts"] | undefined;
  attention?: ProviderAttention[];
  loading?: boolean;
  error?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (loading) return null;
  const summary = error ? { label: "Health data unavailable", color: "var(--warn)" } : deploymentHealthSummary(health, counts);
  if (!summary) return null;
  const dot = <span style={{ width: 7, height: 7, borderRadius: 999, background: summary.color, flexShrink: 0 }} />;
  if (error || attention.length === 0) {
    return <span className="pill" role="status" style={{ color: summary.color }}>{dot}{summary.label}</span>;
  }
  const more = (counts?.unhealthy ?? 0) + (counts?.unknown ?? 0) - attention.length;
  return (
    <div ref={box} style={{ position: "relative" }}>
      <button type="button" className="pill" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}
        style={{ color: summary.color, background: "none", cursor: "pointer", fontFamily: "inherit" }}>
        {dot}{summary.label}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden style={{ transform: open ? "rotate(180deg)" : "none" }}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div role="menu" aria-label="Providers to check"
          style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 400, maxHeight: "60vh", overflowY: "auto", background: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: 10, zIndex: 20, padding: 4 }}>
          {attention.map((p) => {
            // An unhealthy provider says since when and why, on two lines; one
            // with no data says which kind in a few words, on one: nine rows
            // of the same sentence read as noise.
            const unhealthy = p.health === "unhealthy";
            const since = unhealthy ? sinceWords(p.since, p.sinceOrEarlier) : null;
            const word = unhealthy ? `${healthLabel(p.health)}${since ? ` ${since}` : ""}` : CAUSE_SHORT[p.cause] ?? healthLabel(p.health);
            return (
              <Link key={`${p.spec}|${p.endpointId}`} href={providerHref(p)} role="menuitem" onClick={(e) => { setOpen(false); openOnThisPage(e, providerHref(p), pathname); }} className="gw-attn-row"
                title={p.reason} style={{ display: "block", padding: "7px 10px", borderRadius: 7, textDecoration: "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: healthColor(p.health), flexShrink: 0 }} />
                  <span className="gw-mono" style={{ color: "var(--text)", fontWeight: 600 }}>{p.endpointId}</span>
                  <span style={{ color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{buildChainMetaByIndex(p.spec).name}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: healthColor(p.health), fontSize: 11.5, whiteSpace: "nowrap" }}>{word}</span>
                </div>
                {unhealthy && <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 3, paddingLeft: 14, lineHeight: 1.45 }}>{p.reason}</div>}
              </Link>
            );
          })}
          {more > 0 && <div style={{ padding: "6px 10px 8px 24px", fontSize: 11.5, color: "var(--text-4)" }}>{more} more on the Providers tab</div>}
        </div>
      )}
    </div>
  );
}

/**
 * The topbar's pulse — health, provider health counts and the providers
 * behind them — polled on every page. Its own endpoint: a few reads, whatever
 * the chain count (MAG-4296); two more on a chain's page, where it also reads
 * the whole router's status (`allChains`), which is what the topbar shows.
 */
export function useDeploymentPulse() {
  const { withScope, routerId, chain } = useFilters();
  // On a chain's page the provider counts speak for that chain: counting every
  // chain's providers beside one chain's name read as that chain's own trouble.
  // The router's status stays the whole router's (`topbarFigures`).
  const params = [
    ...(chain ? [`spec=${encodeURIComponent(chain)}`] : []),
    ...(routerId ? [`routerId=${encodeURIComponent(routerId)}`] : []),
  ];
  const scoped = withScope("/api/metrics/pulse");
  const url = params.length ? `${scoped}${scoped.includes("?") ? "&" : "?"}${params.join("&")}` : scoped;
  return useApi<DeploymentPulse>(url, 30000, { keepPreviousData: false });
}

export function DeploymentHealth() {
  const { data, isLoading, error } = useDeploymentPulse();
  const { health, counts } = topbarFigures(data);
  return (
    <DeploymentHealthBadge
      health={health}
      counts={counts}
      attention={data?.attention}
      loading={!data && isLoading && !error}
      error={Boolean(error)}
    />
  );
}
