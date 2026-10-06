"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { buildChainMetaByIndex, WINDOWS, type ChainMetrics, type HeroSummary } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useChainFilter, useChainOptions } from "@/hooks/use-chain-options";
import { useRouterFilter, useRouterOptions, type RouterOptionRow } from "@/hooks/use-router-options";
import { useFilters } from "./FiltersProvider";
import { useNewUi } from "./new-ui";
import { ChainBadge } from "./ChainBadge";
import { IconSearch } from "./icons";
import { HEALTH_COLOR, HEALTH_LABEL, HEALTH_UNKNOWN_HINT } from "@/lib/health";
import { errRateColor } from "@/lib/colors";
import { fmtNum } from "@/lib/format";
import { byAttention, chainHref, type DrawerChain } from "@/lib/chain-drawer";

/* The chains drawer: a second column beside the sidebar on the Metrics page,
 * one row per chain with its health, requests and error rate, problems first.
 * Picking a row IS the page's chain filter (`useChainFilter`), so every tab
 * follows it, and the page writes it into its URL (`useScopeInUrl`). A chain
 * that two or more routers serve lists them under it once picked - the only
 * place a router choice exists, since with one router per chain picking the
 * router is picking the chain. */

/** The page the drawer belongs to. */
export const CHAIN_DRAWER_PATH = "/metrics";

/** On its page, inside the Shell, under DASHBOARD_NEW_UI; the standalone page has no drawer. */
const ChainDrawerContext = createContext(false);

export function ChainDrawerProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Without the flag the page is 0.27's, which picks its chain from a dropdown.
  const newUi = useNewUi();
  const onPage = newUi && (pathname === CHAIN_DRAWER_PATH || pathname.startsWith(`${CHAIN_DRAWER_PATH}/`));
  return <ChainDrawerContext.Provider value={onPage}>{children}</ChainDrawerContext.Provider>;
}

/** Whether the chains drawer is on screen (then the page drops its chain and router dropdowns). */
export function useChainDrawer(): { visible: boolean } {
  return { visible: useContext(ChainDrawerContext) };
}

export function ChainDrawer() {
  const { timeWindow } = useFilters();
  const { chain, select } = useChainFilter();
  const { routerId, select: selectRouter } = useRouterFilter();
  const { routers: allRouters } = useRouterOptions();
  const { chains: options } = useChainOptions();
  // Routers per chain, for the chains two or more of them serve.
  const sharedRouters = useMemo(() => {
    const bySpec = new Map<string, RouterOptionRow[]>();
    for (const r of allRouters) bySpec.set(r.spec, [...(bySpec.get(r.spec) ?? []), r]);
    return new Map([...bySpec].filter(([, list]) => list.length > 1));
  }, [allRouters]);
  // The whole deployment, never the picked router's scope: the drawer is how
  // you move between chains, and a router's scope holds only its own chain.
  const metrics = useApi<{ chains: ChainMetrics[] }>(`/api/metrics/chains?window=${timeWindow}`, 30000);
  const traffic = useApi<{ specs: string[] }>("/api/metrics/specs", 60000);
  // Every chain's error rate as one ratio, the same key the Metrics tab's hero
  // reads with no chain or router picked.
  const summary = useApi<HeroSummary>(`/api/metrics/dashboard-summary?window=${timeWindow}`);
  const [query, setQuery] = useState("");

  // Every chain the config declares or the metrics report, with its numbers
  // for the page's window.
  const rows = useMemo<DrawerChain[]>(() => {
    const bySpec = new Map((metrics.data?.chains ?? []).map((c) => [c.spec, c]));
    // Unknown until read, so no row says "no traffic yet" while it loads.
    const served = traffic.data ? new Set(traffic.data.specs) : null;
    const specs = [...new Set([...options.map((o) => o.spec), ...(served ?? []), ...bySpec.keys()])];
    return byAttention(specs.map((spec) => {
      const m = bySpec.get(spec);
      const meta = buildChainMetaByIndex(spec);
      return {
        spec,
        name: meta.name,
        mainnet: meta.mainnet,
        health: m?.health ?? "unknown",
        requests: Math.round(m?.requests ?? 0),
        // Failed over every request, so a chain failing them all reads 100%;
        // null when it had none. `requests` counts only the answered ones.
        errPct: m?.errorRate != null ? m.errorRate * 100 : null,
        noTraffic: served !== null && !served.has(spec) && !m,
      };
    }));
  }, [options, metrics.data, traffic.data]);

  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.spec.toLowerCase().includes(q)) : rows;
  // Mainnet and testnet apart only when both are there.
  const groups: [string | null, DrawerChain[]][] = shown.some((r) => r.mainnet) && shown.some((r) => !r.mainnet)
    ? [["Mainnet", shown.filter((r) => r.mainnet)], ["Testnet", shown.filter((r) => !r.mainnet)]]
    : [[null, shown]];

  const successRate = summary.data?.successRate.value ?? null;
  const unhealthy = rows.filter((r) => r.health === "unhealthy").length;
  const loading = !metrics.data;

  // A plain click picks here; a new tab or window follows the link. A chain
  // row means all of that chain, every router on it included.
  const plain = (e: React.MouseEvent) => !(e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
  const pick = (spec: string | null) => (e: React.MouseEvent) => {
    if (!plain(e)) return;
    e.preventDefault();
    if (routerId !== null) selectRouter(null);
    select(spec);
  };
  const pickRouter = (id: string) => (e: React.MouseEvent) => {
    if (!plain(e)) return;
    e.preventDefault();
    selectRouter(id); // and its chain
  };

  return (
    <aside className="gw-chains">
      <div className="gw-chains__head">
        <span className="title">Chains</span>
      </div>
      {/* By name or spec index; Escape or the x clears it. */}
      <label className="gw-chains__search">
        <IconSearch size={13} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chains" aria-label="Search chains"
          onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search" title="Clear search">×</button>
        )}
      </label>
      <div className="gw-chains__cols" aria-hidden>
        <span>Chain</span>
        <span>Error rate</span>
      </div>
      <nav className="gw-chains__list" aria-label="Chains">
        <a href={chainHref(null)} onClick={pick(null)} className={`gw-chain-row${chain === null ? " active" : ""}`} aria-current={chain === null ? "page" : undefined}>
          <span className="gw-chain-row__all" aria-hidden>
            {rows.slice(0, 3).map((r) => <span key={r.spec} style={{ background: buildChainMetaByIndex(r.spec).color }} />)}
          </span>
          <span className="meta">
            <span className="name">All chains</span>
            <span className="sub">
              {rows.length} chains
              {unhealthy > 0 && <span style={{ color: "var(--err)" }}> · {unhealthy} unhealthy</span>}
            </span>
          </span>
          <ErrRate pct={successRate === null ? null : (1 - successRate) * 100} />
          <span className="dot" style={{ visibility: "hidden" }} />
        </a>
        {groups.map(([label, list]) => (
          <div key={label ?? "all"} className="gw-chains__group">
            {label && <div className="gw-chains__group-label">{label}</div>}
            {list.map((r) => {
              const routers = sharedRouters.get(r.spec) ?? null;
              const open = chain === r.spec;
              return (
                <div key={r.spec}>
                  <ChainRow row={r} routers={routers?.length ?? 0} active={open && routerId === null} open={open}
                    loading={loading} onPick={pick(r.spec)} />
                  {open && routers && (
                    <div className="gw-chain-subrows">
                      {routers.map((rt) => (
                        <a key={rt.id} href={chainHref(r.spec, rt.id)} onClick={pickRouter(rt.id)}
                          className={`gw-chain-subrow${routerId === rt.id ? " active" : ""}`}
                          aria-current={routerId === rt.id ? "page" : undefined}>
                          <span className="id gw-mono">{rt.id}</span>
                          <span className="n">{rt.upstreams} upstream{rt.upstreams === 1 ? "" : "s"}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {q && shown.length === 0 && <div className="gw-chains__empty">No chain matches &ldquo;{query}&rdquo;.</div>}
      </nav>
      <div className="gw-chains__foot">Last {WINDOWS[timeWindow].label} · problems first</div>
    </aside>
  );
}

function ErrRate({ pct }: { pct: number | null }) {
  return (
    <span className="err gw-mono" style={{ color: errRateColor(pct, "var(--text-3)") }}>
      {pct === null ? "" : `${pct.toFixed(2)}%`}
    </span>
  );
}

function ChainRow({ row, routers, active, open, loading, onPick }: {
  row: DrawerChain;
  /** How many routers serve it, when more than one does. */
  routers: number;
  active: boolean;
  /** Picked, possibly with one of its routers. */
  open: boolean;
  loading: boolean;
  onPick: (e: React.MouseEvent) => void;
}) {
  const health = row.health === "unknown" ? HEALTH_UNKNOWN_HINT : HEALTH_LABEL[row.health];
  return (
    <a href={chainHref(row.spec)} onClick={onPick} aria-current={active ? "page" : undefined}
      className={`gw-chain-row${active ? " active" : ""}${open ? " open" : ""}${row.noTraffic ? " muted" : ""}`}>
      <ChainBadge spec={row.spec} size={18} />
      <span className="meta">
        <span className="name">{row.name}</span>
        <span className="sub">{row.noTraffic ? "no traffic yet" : loading ? "…" : `${fmtNum(row.requests)} requests`}</span>
        {/* Its own line: beside the requests it would be cut off. */}
        {routers > 1 && <span className="sub">{routers} routers</span>}
      </span>
      <ErrRate pct={row.noTraffic || loading ? null : row.errPct} />
      <span className="dot" role="img" aria-label={health} title={health} style={{ background: HEALTH_COLOR[row.health] }} />
    </a>
  );
}
