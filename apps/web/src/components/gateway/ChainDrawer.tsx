"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { buildChainMetaByIndex, WINDOWS, type ChainMetrics, type HeroSummary } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useChainFilter, useChainOptions } from "@/hooks/use-chain-options";
import { useRouterFilter, useRouterOptions, type RouterOptionRow } from "@/hooks/use-router-options";
import { useFilters } from "./FiltersProvider";
import { useNewUi } from "./new-ui";
import { ChainBadge } from "./ChainBadge";
import { IconMenu, IconSearch } from "./icons";
import { HEALTH_COLOR, HEALTH_LABEL, HEALTH_UNKNOWN_HINT } from "@/lib/health";
import { errRateColor } from "@/lib/colors";
import { fmtNum } from "@/lib/format";
import { byAttention, chainHref, type DrawerChain } from "@/lib/chain-drawer";

/* The chains drawer: on the Metrics page it is drawn over the sidebar, in the
 * same column, so the screen never shows two lists side by side. Its menu
 * button shows the menu again; the menu's Metrics brings the drawer back. One
 * row per chain with its health, requests and error rate, problems first.
 * Picking a row IS the page's chain filter (`useChainFilter`), so every tab
 * follows it, and the page writes it into its URL (`useScopeInUrl`). A chain
 * that two or more routers serve lists them under it once picked - the only
 * place a router choice exists, since with one router per chain picking the
 * router is picking the chain. */

/** The page the drawer belongs to. */
export const CHAIN_DRAWER_PATH = "/metrics";

export interface ChainDrawerState {
  /** On its page, inside the Shell, under DASHBOARD_NEW_UI (then the page
   *  drops its chain and router dropdowns); the standalone page has no drawer. */
  visible: boolean;
  /** Drawn over the menu. False while the menu shows, and off its page. */
  covering: boolean;
  /** The Shell was already on screen, so a drawer arriving now slides in. */
  settled: boolean;
  setCovering: (covering: boolean) => void;
}

const ChainDrawerContext = createContext<ChainDrawerState>({
  visible: false, covering: false, settled: false, setCovering: () => {},
});

export function ChainDrawerProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Without the flag the page is 0.27's, which picks its chain from a dropdown.
  const newUi = useNewUi();
  const onPage = newUi && (pathname === CHAIN_DRAWER_PATH || pathname.startsWith(`${CHAIN_DRAWER_PATH}/`));
  // Over the menu each time the page is reached, whatever it was when you left.
  const [covering, setCovering] = useState(true);
  const [wasOnPage, setWasOnPage] = useState(onPage);
  if (wasOnPage !== onPage) {
    setWasOnPage(onPage);
    if (onPage) setCovering(true);
  }
  // A page that loads on Metrics has the drawer in place from its first frame;
  // only one reached by a later navigation slides in.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const value = useMemo(
    () => ({ visible: onPage, covering: onPage && covering, settled, setCovering }),
    [onPage, covering, settled],
  );
  return <ChainDrawerContext.Provider value={value}>{children}</ChainDrawerContext.Provider>;
}

export function useChainDrawer(): ChainDrawerState {
  return useContext(ChainDrawerContext);
}

export function ChainDrawer() {
  const { covering, settled, setCovering } = useChainDrawer();
  // Decided once, when the drawer appears: a later change is a transition.
  const [enter] = useState(settled);
  // Focus goes with the panel on screen: to the menu button when the drawer
  // comes over the menu (the Metrics link just used is under it now).
  const menu = useRef<HTMLButtonElement>(null);
  const wasCovering = useRef(enter ? false : covering);
  useEffect(() => {
    if (covering && !wasCovering.current) menu.current?.focus({ preventScroll: true });
    wasCovering.current = covering;
  }, [covering]);
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
    <aside className={`gw-chains${covering ? " gw-chains--covering" : ""}${enter ? " gw-chains--enter" : ""}`} inert={!covering}>
      <div className="gw-chains__head">
        {/* The menu icon, not a back arrow: "‹ Chains" reads as a way back to Chains. */}
        <button ref={menu} type="button" className="gw-chains__menu" onClick={() => setCovering(false)}
          aria-label="Show menu" title="Show menu">
          <IconMenu size={16} />
        </button>
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
