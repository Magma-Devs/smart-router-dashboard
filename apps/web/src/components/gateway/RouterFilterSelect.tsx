"use client";

import { useEffect, useRef, useState } from "react";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { useRouterFilter } from "@/hooks/use-router-options";

/**
 * "All routers" — the config-router filter, styled as ChainSelect's sibling
 * because it answers the question next to it: a chain filter alone can't
 * represent a chain that several routers serve.
 *
 * One click sets BOTH router axes (see `use-router-options.ts`): the config id
 * that filters per-upstream rows, and — only when the collector reports a
 * matching scrape target — the label scope that narrows the PromQL too. Doing
 * it in one place is what keeps the two from drifting apart.
 *
 * Renders nothing when the config declares fewer than two routers: there is
 * nothing to choose between, and a filter that can't change anything is worse
 * than no filter (the rule RouterSelect already followed).
 */
export function RouterFilterSelect() {
  const { routerId, routers, scopeUnavailable, select: selectRouter, totalRouters } = useRouterFilter();
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

  // Keyed on the deployment's router count, not the chain-narrowed list: with a
  // chain picked whose one router is the answer, the control has to stay and
  // name it. It disappears only where there was never a choice to make.
  if (totalRouters < 2) return null;

  /* A selection that left the config reads as "All routers" rather than
     narrowing everything to nothing — derived, not reset (same rule as the
     chain picker). */
  const current = routers.find((r) => r.id === routerId) ?? null;

  const select = (id: string | null) => {
    selectRouter(id);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)}
        aria-label="Filter by router"
        title={scopeUnavailable
          ? "Filters the upstream roster, which is keyed per upstream. Chain-level panels stay deployment-wide: the router labels its series with the chain, and this collector attaches no per-router label to split them."
          : undefined}
        style={{ height: 32, padding: "0 9px", borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--surface)", color: "var(--text)", fontSize: 12, fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}>
        <IconRouter />
        <span>{current ? current.id : "All routers"}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 120, minWidth: 220, padding: 4, borderRadius: 9, background: "var(--surface-2)", border: "1px solid var(--line-2)", boxShadow: "0 10px 30px rgba(0,0,0,0.5)", maxHeight: 320, overflowY: "auto" }}>
          <button onClick={() => select(null)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 6, border: "none", background: routerId === null ? "var(--hover)" : "transparent", color: "var(--text)", fontSize: 12, fontFamily: "inherit", cursor: "pointer", textAlign: "left" }}>
            <IconRouter />
            All routers
          </button>
          {routers.map((r) => (
            <button key={r.id} onClick={() => select(r.id)}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 6, border: "none", background: routerId === r.id ? "var(--hover)" : "transparent", color: "var(--text)", fontSize: 12, fontFamily: "inherit", cursor: "pointer", textAlign: "left" }}>
              <ChainBadge spec={r.spec} size={16} />
              <span className="gw-mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.id}</span>
              {/* The row's subject is the ROUTER's name. The chain only earns
                  space when it says something the name doesn't — an SR_CONFIG
                  mount names each router after the chain it serves, and
                  repeating it there turned this into a list of chains. */}
              {hintFor(r) && (
                <span style={{ marginLeft: "auto", paddingLeft: 8, fontSize: 10, color: "var(--text-4)", whiteSpace: "nowrap" }}>
                  {hintFor(r)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What to say after a router's name: that another router serves its chain (the
 * case this filter exists for), and the chain itself only when the name isn't
 * already it — `ETH1` serving Ethereum needs no gloss, `eth-prod` does.
 */
function hintFor(r: { id: string; spec: string; chainName: string; sharesChain: boolean }): string {
  const fold = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const namesItsChain = fold(r.id) === fold(r.spec) || fold(r.id) === fold(r.chainName);
  const parts = [];
  if (!namesItsChain) parts.push(r.chainName);
  if (r.sharesChain) parts.push("shared chain");
  return parts.join(" · ");
}

function IconRouter() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6.5" y1="18" x2="6.51" y2="18"/><line x1="10.5" y1="18" x2="10.51" y2="18"/><path d="M12 10V2"/><path d="M8 6l4-4 4 4"/>
    </svg>
  );
}
