"use client";

/**
 * The Issues tab, clustered by chain.
 *
 * Severity-first answers OUR question — what is worst across the deployment.
 * A customer whose chain is not responding does not care that Solana is worse;
 * they want their chain, its providers, and what is happening. So the
 * container is the CHAIN, and severity becomes a property of a row inside it
 * rather than the thing that splits the page.
 *
 * Chains are still ordered worst-first, so nothing is buried: a container with
 * a critical row sorts above one with only config rows. What changes is that
 * everything about one chain is now in one place.
 *
 * ## What a provider row carries
 *
 * Role, interface and addons, because those are what decide whether a failure
 * had anywhere to go. An addon only one provider declares means a failure
 * there has NO failover — that is a setup problem, and it is invisible unless
 * the addons are on screen next to the error.
 */
import { useState } from "react";
import type { StatusFinding, RouterTopology } from "@sr/shared";

const TIER_COLOR: Record<string, string> = {
  critical: "var(--err, #ef4444)",
  attention: "var(--warn, #f59e0b)",
  config: "var(--text-3, #64748b)",
};

/** Worst tier first, so a chain is ranked by its worst row. */
const TIER_RANK: Record<string, number> = { critical: 0, attention: 1, config: 2 };

export interface ChainGroup {
  spec: string;
  chainName: string;
  findings: StatusFinding[];
  /** Providers the config declares here — including ones with no findings. */
  configured: { upstream: string; role: "primary" | "backup" | null; interfaces: string[]; addons: string[] }[];
  worstRank: number;
}

/** Group findings by chain and fold the config in beside them. */
export function groupByChain(findings: StatusFinding[], routers: RouterTopology[]): ChainGroup[] {
  const bySpec = new Map<string, ChainGroup>();

  for (const f of findings) {
    const g = bySpec.get(f.spec) ?? {
      spec: f.spec,
      chainName: f.chainName,
      findings: [],
      configured: [],
      worstRank: 9,
    };
    g.findings.push(f);
    g.worstRank = Math.min(g.worstRank, TIER_RANK[f.tier] ?? 9);
    bySpec.set(f.spec, g);
  }

  // The config half. A provider with no findings still belongs on screen —
  // "blockdaemon is here and clean" is what makes "lava is the only one with
  // debug" legible.
  for (const r of routers) {
    const g = bySpec.get(r.spec);
    if (!g) continue;
    for (const n of r.nodes) {
      if (g.configured.some((c) => c.upstream === n.name)) continue;
      g.configured.push({
        upstream: n.name,
        role: n.isBackup ? "backup" : "primary",
        interfaces: [...new Set(n.endpoints.map((e) => e.interface).filter(Boolean))],
        addons: [...new Set(n.endpoints.flatMap((e) => e.addons ?? []))],
      });
    }
  }

  return [...bySpec.values()].sort(
    (a, b) => a.worstRank - b.worstRank || b.findings.length - a.findings.length,
  );
}

/** An addon only ONE provider on the chain declares — a failure there cannot fail over. */
function soleAddons(g: ChainGroup): string[] {
  const count = new Map<string, number>();
  for (const c of g.configured) for (const a of c.addons) count.set(a, (count.get(a) ?? 0) + 1);
  return [...count.entries()].filter(([, n]) => n === 1).map(([a]) => a);
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        padding: "1px 5px",
        borderRadius: 3,
        color: tone ?? "var(--text-3)",
        border: `1px solid ${tone ?? "var(--text-4)"}`,
        opacity: 0.9,
      }}
    >
      {children}
    </span>
  );
}

function ProviderLine({
  c,
  findings,
  sole,
}: {
  c: ChainGroup["configured"][number];
  findings: StatusFinding[];
  sole: string[];
}) {
  const mine = findings.filter((f) => f.upstream === c.upstream);
  const worst = mine.reduce((acc, f) => Math.min(acc, TIER_RANK[f.tier] ?? 9), 9);
  const tone = worst === 0 ? TIER_COLOR.critical : worst === 1 ? TIER_COLOR.attention : undefined;

  return (
    <div style={{ padding: "7px 0", borderTop: "1px solid var(--border, #222)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: tone }}>{c.upstream}</span>
        <Tag tone={c.role === "primary" ? "#60a5fa" : "#fb923c"}>{c.role ?? "?"}</Tag>
        {c.interfaces.map((i) => (
          <Tag key={i}>{i}</Tag>
        ))}
        {c.addons.map((a) => (
          // An addon nobody else on this chain declares is the failover gap.
          <Tag key={a} tone={sole.includes(a) ? "#fbbf24" : undefined}>
            {a}
            {sole.includes(a) ? " · only" : ""}
          </Tag>
        ))}
        {mine.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--text-4)" }}>no findings in this window</span>
        )}
      </div>
      {mine.map((f) => (
        <div key={f.id} style={{ fontSize: 11.5, color: "var(--text-2)", marginTop: 3, paddingLeft: 2 }}>
          <span style={{ color: TIER_COLOR[f.tier] ?? "var(--text-3)" }}>•</span> {f.headline}
          <span style={{ color: "var(--text-4)" }}> · {f.metric.value} {f.metric.label}</span>
        </div>
      ))}
    </div>
  );
}

export function ByChain({ groups }: { groups: ChainGroup[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set(groups.slice(0, 2).map((g) => g.spec)));

  if (groups.length === 0) {
    // Not "all clear" — the page never says that. No rule crossed.
    return (
      <div style={{ padding: "14px 18px", fontSize: 12.5, color: "var(--text-3)" }}>
        No chain crossed a rule in this window.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {groups.map((g) => {
        const sole = soleAddons(g);
        const isOpen = open.has(g.spec);
        // Chain-level findings (no upstream) sit above the providers: they are
        // about the chain, not about any one node.
        const chainLevel = g.findings.filter((f) => !f.upstream);
        return (
          <section key={g.spec} className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
            <button
              onClick={() =>
                setOpen((s) => {
                  const n = new Set(s);
                  if (n.has(g.spec)) n.delete(g.spec);
                  else n.add(g.spec);
                  return n;
                })
              }
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                background: "none",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                borderLeft: `3px solid ${
                  g.worstRank === 0 ? TIER_COLOR.critical : g.worstRank === 1 ? TIER_COLOR.attention : TIER_COLOR.config
                }`,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{g.chainName}</span>
              <span style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{g.spec}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: "var(--text-3)" }}>
                {g.findings.length} {g.findings.length === 1 ? "issue" : "issues"} ·{" "}
                {g.configured.length || "?"} providers
              </span>
              <span style={{ fontSize: 10, color: "var(--text-4)" }}>{isOpen ? "▾" : "▸"}</span>
            </button>

            {isOpen && (
              <div style={{ padding: "0 14px 12px" }}>
                {chainLevel.map((f) => (
                  <div key={f.id} style={{ fontSize: 11.5, color: "var(--text-2)", padding: "3px 0" }}>
                    <span style={{ color: TIER_COLOR[f.tier] ?? "var(--text-3)" }}>•</span> {f.headline}
                    <span style={{ color: "var(--text-4)" }}> · {f.metric.value} {f.metric.label}</span>
                  </div>
                ))}
                {g.configured.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-4)", paddingTop: 6 }}>
                    No values file mounted — roles, interfaces and addons are unknown for this chain.
                  </div>
                ) : (
                  g.configured.map((c) => (
                    <ProviderLine key={c.upstream} c={c} findings={g.findings} sole={sole} />
                  ))
                )}
                {sole.length > 0 && (
                  <div style={{ fontSize: 11, color: "#fbbf24", paddingTop: 8 }}>
                    {sole.join(", ")} {sole.length === 1 ? "is" : "are"} declared by only one provider here — a
                    failure on it has nothing to fail over to.
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
