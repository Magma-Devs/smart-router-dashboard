"use client";

import { useMemo } from "react";
import { buildChainMetaByIndex, type RouterTopology } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";

/**
 * The routers a deployment has, for the "All routers" filter.
 *
 * "Router" means two things in this codebase and the filter has to bridge them:
 *
 * 1. **A config router** — an entry in the mounted values file, with an id, a
 *    chain and its own upstreams. This is the identity a user means, and the
 *    only one that can tell two routers on ONE chain apart, because the config
 *    is where that distinction is written down.
 * 2. **A scrape target** — the value of `ROUTER_SCOPE_LABEL` (`service` by
 *    default) that Prometheus attaches per target. This is the only thing that
 *    can split chain-level SERIES per router, since the router labels its
 *    metrics with the chain and never with itself.
 *
 * The list is the config's, because that's the one that always exists. Each row
 * carries `scopeValue` when the collector actually reports a matching target —
 * the chart's Service name is `<id-lowered>-router`, checked against
 * `/api/metrics/routers` rather than assumed — and selecting such a router can
 * additionally narrow the PromQL. When it's null, per-upstream rows still
 * filter honestly (they're keyed per endpoint), but chain-level aggregates
 * can't be attributed and must not pretend to be.
 */
export interface RouterOptionRow {
  /** Config router id — `ETH1`, `eth-prod`, … */
  id: string;
  /** Chain (spec) it serves, for the dropdown's second line. */
  spec: string;
  chainName: string;
  /** Target-label value that scopes the metrics to it, when one exists. */
  scopeValue: string | null;
  /** Another config router serves the same chain — the case a chain filter
   *  alone can't represent, and the reason this filter exists. */
  sharesChain: boolean;
}

export function useRouterOptions(): {
  routers: RouterOptionRow[];
  /** The collector's scope label, for copy that has to name it. */
  scopeLabel: string | null;
  /** True when NO router maps to a scrape target: chain-level panels can't be
   *  split, only per-upstream rows. */
  scopeUnavailable: boolean;
} {
  const config = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  const scope = useApi<{ label: string; routers: string[] }>("/api/metrics/routers", 300000);

  return useMemo(() => {
    const topology = config.data?.routers ?? [];
    const scopeValues = new Set(scope.data?.routers ?? []);
    const perSpec = new Map<string, number>();
    for (const r of topology) perSpec.set(r.spec, (perSpec.get(r.spec) ?? 0) + 1);

    const routers = topology.map((r) => {
      // Chart-derived Service name, ACCEPTED ONLY IF THE COLLECTOR REPORTS IT.
      const candidate = `${r.id.toLowerCase()}-router`;
      return {
        id: r.id,
        spec: r.spec,
        chainName: buildChainMetaByIndex(r.spec).name,
        scopeValue: scopeValues.has(candidate) ? candidate : scopeValues.has(r.id) ? r.id : null,
        sharesChain: (perSpec.get(r.spec) ?? 0) > 1,
      };
    });
    return {
      routers,
      scopeLabel: scope.data?.label ?? null,
      scopeUnavailable: routers.length > 0 && routers.every((r) => r.scopeValue === null),
    };
  }, [config.data, scope.data]);
}

/**
 * The router filter as the UI uses it.
 *
 * The list is narrowed by the chain filter — with a chain picked, the only
 * routers that can matter are the ones serving it, and offering the rest
 * invites a selection that narrows everything to nothing. The selection is
 * derived against that narrowed list for the same reason the chain picker
 * derives its own: a router the list no longer contains reads as "All routers"
 * everywhere, so the control and the rows can't disagree. (The chain picker
 * clears it outright — see `useChainFilter` — so this is the belt to that
 * braces.)
 *
 * Selecting a router sets both axes at once: the config id that filters
 * per-upstream rows, and the collector's label scope when this router has one
 * (cleared otherwise, so a stale scope can't keep narrowing the queries).
 * Every control that changes the router selection goes through here — the
 * dropdown and the "Clear filter" banner both — because two callers doing it
 * by hand is how the axes drift apart.
 */
export function useRouterFilter(): {
  /** Effective selection — null when no router is picked OR the picked one is
   *  outside the chain-narrowed list. */
  routerId: string | null;
  routers: RouterOptionRow[];
  scopeUnavailable: boolean;
  select: (id: string | null) => void;
  /** `&routerId=…` (or "") for the routes that take it. Derived here rather
   *  than on the context so it can never carry a selection the list dropped. */
  routerIdQ: string;
  /** Routers the DEPLOYMENT has, before the chain filter narrows the list —
   *  what the control's visibility keys on, so picking a chain served by one
   *  router narrows the list instead of making the control disappear. */
  totalRouters: number;
} {
  const { chain, setChain, routerId, setRouterId, setRouter } = useFilters();
  const { routers: all, scopeUnavailable } = useRouterOptions();
  const routers = chain ? all.filter((r) => r.spec === chain) : all;
  const effective = routerId !== null && routers.some((r) => r.id === routerId) ? routerId : null;
  const select = (id: string | null) => {
    setRouterId(id);
    const picked = id === null ? null : (all.find((r) => r.id === id) ?? null);
    setRouter(picked?.scopeValue ?? null);
    // A config router serves ONE chain, so picking it also picks that chain —
    // which is what narrows the panels that aggregate by chain and can't be
    // attributed to a router any other way. Setting it rather than deriving it
    // keeps the chain box honest about what is being shown.
    if (picked) setChain(picked.spec);
  };
  return {
    routerId: effective,
    routers,
    scopeUnavailable,
    select,
    routerIdQ: effective ? `&routerId=${encodeURIComponent(effective)}` : "",
    totalRouters: all.length,
  };
}
