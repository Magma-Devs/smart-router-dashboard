"use client";

/* ChainAvailability — the Metrics tab's Availability card once a chain is
 * picked: availability in blocks (AvailabilityBreakdown), all the providers
 * and each one. It follows the router picked in the chains list; with none
 * picked, a chain two routers serve shows every provider of the chain. */

import { buildChainMetaByIndex, type MetricWindow } from "@sr/shared";
import { useRouterFilter } from "@/hooks/use-router-options";
import { Tip } from "@/components/gateway/Tip";
import { AvailabilityBreakdown } from "./AvailabilityBreakdown";

export function ChainAvailability({ spec, timeWindow }: { spec: string; timeWindow: MetricWindow }) {
  const { routerId } = useRouterFilter();
  const chain = buildChainMetaByIndex(spec).name;
  return (
    <div className="gw-card" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)", display: "flex", alignItems: "center", marginBottom: 10 }}>
        Availability · {chain}{routerId && <span style={{ fontWeight: 400, color: "var(--text-4)", marginLeft: 6 }}>· {routerId}</span>}
        <Tip text={"**The share of tries that succeeded**, a block per stretch of the window. The top row is all the providers together; each row under it is one provider.\n\n**No traffic** is a block a provider took no tries in: a standby backup wasn't asked, which is not the same as available."} />
      </div>
      <AvailabilityBreakdown key={routerId ?? "all"} spec={spec} routerId={routerId} win={timeWindow} />
    </div>
  );
}
