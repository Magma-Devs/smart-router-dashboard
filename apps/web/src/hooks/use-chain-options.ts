"use client";

import { useMemo } from "react";
import { buildChainMetaByIndex, type RouterTopology } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { useRouterOptions } from "@/hooks/use-router-options";
import type { ChainOption } from "@/components/gateway/ChainSelect";

/**
 * ONE list of chains for the chain picker, wherever it renders.
 *
 * The two callers used to read different sources: the Metrics page took
 * `/api/metrics/specs` (chains that have served traffic) and the Upstreams
 * page took the mounted config (chains that are declared). Neither is wrong
 * for its own page, but the same control then offered different lists
 * depending on where you stood — and a configured chain nobody had called yet
 * was missing from the Metrics box entirely.
 *
 * So this returns the UNION, each row saying which side it came from. A page
 * decides what to do with a chain it can't say much about (grey it out with a
 * hint, typically) instead of hiding it and leaving the user to wonder.
 */
export interface ChainOptionRow extends ChainOption {
  /** Declared by the mounted values file. */
  inConfig: boolean;
  /** Has served traffic in the metrics the router exposes. */
  hasTraffic: boolean;
}

export function useChainOptions(): { chains: ChainOptionRow[]; loading: boolean } {
  const { withScope } = useFilters();
  // Both keys are already fetched by the pages that use them, so SWR serves
  // these from cache rather than doubling the requests.
  const config = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  const specs = useApi<{ specs: string[] }>(withScope("/api/metrics/specs"), 60000);

  const chains = useMemo<ChainOptionRow[]>(() => {
    const configSpecs = new Set((config.data?.routers ?? []).map((r) => r.spec));
    const trafficSpecs = new Set(specs.data?.specs ?? []);
    return [...new Set([...configSpecs, ...trafficSpecs])].map((spec) => {
      const meta = buildChainMetaByIndex(spec);
      return {
        spec,
        name: meta.name,
        color: meta.color,
        inConfig: configSpecs.has(spec),
        hasTraffic: trafficSpecs.has(spec),
      };
    });
  }, [config.data, specs.data]);

  return { chains, loading: !config.data && !specs.data };
}

/** Grey out (but still offer) the chains a page can't populate, with the
 *  reason — `muted` rows keep their place in the list. */
export function withMutedRows(
  rows: ChainOptionRow[],
  isMuted: (row: ChainOptionRow) => false | string,
): ChainOption[] {
  return rows.map((row) => {
    const reason = isMuted(row);
    return reason === false ? row : { ...row, muted: true, hint: reason };
  });
}

/**
 * The chain control. Picking a chain narrows the router list to the routers
 * serving it (`useRouterFilter`), so a router outside that list can't stay
 * selected — this clears it, rather than leaving a filter that has quietly
 * stopped applying. Both controls change the pair through a hook so the pair
 * stays consistent without an effect watching for the mismatch.
 */
export function useChainFilter(): {
  chain: string | null;
  select: (spec: string | null) => void;
} {
  const { chain, setChain, routerId, setRouterId, setRouter } = useFilters();
  const { routers } = useRouterOptions();
  const select = (spec: string | null) => {
    setChain(spec);
    if (spec === null || routerId === null) return;
    const current = routers.find((r) => r.id === routerId);
    if (!current || current.spec !== spec) {
      setRouterId(null);
      setRouter(null);
    }
  };
  return { chain, select };
}
