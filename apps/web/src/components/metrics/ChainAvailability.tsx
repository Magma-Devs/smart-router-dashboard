"use client";

/* ChainAvailability — the Metrics tab's Availability card once a chain is
 * picked: the chain's router in blocks (AvailabilityBreakdown), all its
 * providers and each one. A chain two or more routers serve gets a router
 * picker beside the title; one router, none. It starts on the router the page
 * has picked, if any. */

import { useState } from "react";
import { buildChainMetaByIndex, type MetricWindow } from "@sr/shared";
import { useRouterFilter } from "@/hooks/use-router-options";
import { Tip } from "@/components/gateway/Tip";
import { AvailabilityBreakdown } from "./AvailabilityBreakdown";
import { FilterSelect, filterSelectStyle } from "./request-log";

export function ChainAvailability({ spec, timeWindow }: { spec: string; timeWindow: MetricWindow }) {
  const { routerId: pageRouter, routers: all } = useRouterFilter();
  const routers = all.filter((r) => r.spec === spec);
  const [picked, setPicked] = useState<string | null>(null);
  // The page's router wins when it changes; the card's own pick holds until then.
  const [seenPage, setSeenPage] = useState(pageRouter);
  if (seenPage !== pageRouter) { setSeenPage(pageRouter); setPicked(null); }
  const routerId = [picked, pageRouter].find((id) => id && routers.some((r) => r.id === id)) ?? routers[0]?.id ?? null;
  const chain = buildChainMetaByIndex(spec).name;

  return (
    <div className="gw-card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)", flex: 1, display: "inline-flex", alignItems: "center" }}>
          Availability · {chain}
          <Tip text={"**The share of tries that succeeded**, a block per stretch of the window. The top row is all of the router's providers together; each row under it is one provider.\n\n**No traffic** is a block a provider took no tries in: a standby backup wasn't asked, which is not the same as available."} />
        </div>
        {routers.length > 1 && (
          <FilterSelect aria-label="Router" value={routerId ?? ""} onChange={(e) => setPicked(e.target.value)} style={{ ...filterSelectStyle, height: 28 }}>
            {routers.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
          </FilterSelect>
        )}
      </div>
      <AvailabilityBreakdown key={routerId ?? "none"} spec={spec} routerId={routerId} win={timeWindow} />
    </div>
  );
}
