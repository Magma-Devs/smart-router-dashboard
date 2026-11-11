"use client";

/* ProvidersTab — the body of the Providers page: every upstream grouped by the
 * company that runs it (Tatum, Blockdaemon, …) across all chains, then one
 * provider's chains and methods. Same building blocks as the Upstreams tab (gw-card
 * roster, PMStat cards, ThCol/useSort tables), so the two read as one page.
 * Live data: /api/metrics/providers (roster) + /api/metrics/provider-detail.
 * Honest-state notes:
 *  - a family the router doesn't emit (rate-limit hold-offs, timeouts, the
 *    blocked gauge) renders "—" with a tip saying so, never 0;
 *  - "Uptime" counts a minute as down when half or more of the provider's
 *    tries on a chain failed (the PRD's rule), rate limits left out: a "too
 *    many requests" is often the plan's limit, so it is its own "rate-limited
 *    time". It is not the router's health gauge: that starts healthy and only
 *    traffic moves it, so an idle or disabled upstream would read 100%;
 *  - traffic under label values that can't be a node name is counted once,
 *    below the table, instead of inventing a provider for it;
 *  - "Error replies" are requests the provider answered with an error. The
 *    router counts those as served, so they are in no error rate: a node that
 *    refuses nine calls in ten would otherwise look healthy here;
 *  - a read the store didn't answer is said, never drawn as an empty table. */

import { useEffect, useMemo, useState } from "react";
import {
  buildChainMetaByIndex,
  WINDOWS,
  type MetricWindow,
  type ProviderChainStats,
  type ProviderDetailReport,
  type ProviderMethodStats,
  type ProviderSummary,
  type ProvidersReport,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { Tip } from "@/components/gateway/Tip";
import { ThCol, useSort } from "@/components/gateway/SortTable";
import { Refreshing, Skel, SkelRows } from "@/components/gateway/Skel";
import { UpstreamLogo } from "@/components/upstreams/UpstreamLogo";
import { errRateColor, tipLagColor, uptimeColorFrac } from "@/lib/colors";
import { fmtLag, fmtNum } from "@/lib/format";
import { PMNoVal, PMPanel, PMStat } from "@/components/metrics/upstream/PMPanel";
import { ProviderCharts } from "./ProviderCharts";
import type { ReportTarget } from "./report-target";

const NOT_EMITTED = "This router build doesn't emit the metric behind this number yet.";
const TIP_TIMEOUTS =
  "**Timeouts and refused or reset connections** as a share of the tries sent to this provider. The router counts these together today - a separate timeout figure needs an error-type label on the router's counters.";
const TIP_UPTIME =
  "Of every minute this provider served one of your chains, the share that **wasn't down**. A minute is down when half or more of its requests failed, **rate limits not counted** - they have their own column. An error reply is an answer, so it doesn't make a minute down either. Read for windows of a day or less.";
const TIP_LIMITED =
  "Minutes where half or more of its requests got **\"too many requests\"**. They don't count as down: a rate limit is often your plan's limit, not the provider failing. Read for windows of a day or less.";
const LIMITED_UNKNOWN =
  "Not read for windows longer than a day, or when the router's rate-limit counts don't say which chain they were on.";
const TIP_OTHERS =
  "The error rate of the **other providers on this chain**, together, over the same window. If they are fine and this one isn't, the problem is this provider, not the chain.";
const UPTIME_NOT_READ = "Uptime isn't read for windows longer than a day - it needs every minute of the window. Pick a day or less.";
const TIP_RATE =
  "Times the provider answered **\"too many requests\"** and the router held it off. A provider that limits your whole account counts every chain here together.";
const TIP_REPLIES =
  "Requests this provider **answered with an error**, for example \"method not supported\" or \"execution reverted\". The router counts these as served, so they are **not** in the error rate. Some are the caller's own mistake.";
/** The peak averages 5 minutes, or longer on a window too long to read every 5 minutes of - the api says which. */
const tipPeak = (sec: number | undefined) => {
  const min = Math.round((sec ?? 300) / 60);
  return `The highest **${min}-minute average** request rate in the window, all of this provider's chains together.`;
};

/** The Report button stays at the table's right edge while the columns scroll under it. */
const STICKY_CELL: React.CSSProperties = { textAlign: "right", position: "sticky", right: 0, background: "var(--surface)", boxShadow: "-1px 0 0 var(--line)" };
const STICKY_HEAD: React.CSSProperties = { position: "sticky", right: 0, boxShadow: "-1px 0 0 var(--line)" };

/** A column name on two lines: these tables are ten columns wide on a laptop screen. */
const two = (a: string, b: string) => <span>{a}<br />{b}</span>;

const fmtRps = (n: number | null) =>
  n == null ? "—" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : n >= 10 ? Math.round(n).toString() : n.toFixed(1);
const pctCell = (r: number | null, emitted = true) =>
  !emitted ? (
    <span style={{ fontSize: 12, color: "var(--text-4)" }} title={NOT_EMITTED}>—</span>
  ) : r == null ? (
    <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>
  ) : (
    <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: errRateColor(r * 100, "var(--text-3)") }}>
      {(r * 100).toFixed(2)}%
    </span>
  );
const numCell = (n: number | null, emitted = true, color = "var(--text)") =>
  !emitted ? (
    <span style={{ fontSize: 12, color: "var(--text-4)" }} title={NOT_EMITTED}>—</span>
  ) : n == null ? (
    <span style={{ fontSize: 12, color: "var(--text-4)" }}>—</span>
  ) : (
    <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: n > 0 ? color : "var(--text-4)" }}>{fmtNum(n)}</span>
  );
const LATENCY_NOT_READ = "Latency isn't read for windows longer than a day - the read is too heavy for the metrics store. Pick a day or less to see it.";
const msCell = (ms: number | null, read = true) =>
  ms == null ? (
    <span style={{ fontSize: 12, color: "var(--text-4)" }} title={read ? undefined : LATENCY_NOT_READ}>—</span>
  ) : (
    <span className="gw-mono gw-tnum" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{Math.round(ms)} ms</span>
  );
const minutesCell = (n: number | null) =>
  n == null ? (
    <span style={{ fontSize: 12, color: "var(--text-4)" }} title={LIMITED_UNKNOWN}>—</span>
  ) : (
    <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: n > 0 ? "var(--warn)" : "var(--text-4)", whiteSpace: "nowrap" }}>{fmtNum(n)} min</span>
  );
const othersCell = (o: ProviderChainStats["others"]) =>
  o.providers === 0 ? (
    <span style={{ fontSize: 12, color: "var(--text-4)" }} title="No other provider serves this chain for you.">None</span>
  ) : (
    <span title={`${o.providers} other provider${o.providers === 1 ? "" : "s"}, ${fmtNum(o.requests)} requests${o.nodeErrorRate != null ? `, ${(o.nodeErrorRate * 100).toFixed(2)}% answered with an error` : ""}`}>
      {pctCell(o.errorRate)}
    </span>
  );
const uptimeCell = (u: number | null, read = true, down: number | null = null) =>
  u == null ? (
    <span style={{ fontSize: 12, color: "var(--text-4)" }} title={read ? undefined : UPTIME_NOT_READ}>—</span>
  ) : (
    <span className="gw-mono gw-tnum" style={{ fontSize: 12, color: uptimeColorFrac(u) }}
      title={down != null ? `${fmtNum(down)} down minute${down === 1 ? "" : "s"}` : undefined}>{(u * 100).toFixed(2)}%</span>
  );

function Badge({ children, tone }: { children: React.ReactNode; tone: "err" | "primary" | "backup" | "muted" }) {
  const c =
    tone === "err"
      ? { color: "var(--err)", bg: "rgba(239,68,68,0.1)" }
      : tone === "primary"
        ? { color: "#60a5fa", bg: "rgba(96,165,250,0.1)" }
        : tone === "backup"
          ? { color: "#fb923c", bg: "rgba(251,146,60,0.1)" }
          : { color: "var(--text-3)", bg: "var(--hover)" };
  return (
    <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "1px 6px", borderRadius: 4, color: c.color, background: c.bg, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

/* ── Roster ─────────────────────────────────────────────────────────────── */

interface RosterRow {
  p: ProviderSummary;
  natural: number;
  name: string;
  chains: number;
  requests: number;
  peak: number;
  err: number;
  replies: number;
  timeouts: number;
  p95: number;
  rate: number;
  uptime: number;
  limited: number;
}

function ProvidersRoster({ report, rows, activeId, onSelect, timeWindow, loading, refreshing, stale, actions }: {
  report: ProvidersReport | undefined;
  rows: ProviderSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  timeWindow: MetricWindow;
  loading: boolean;
  refreshing: boolean;
  /** The last refresh failed: the rows are the read before it. */
  stale: boolean;
  actions?: React.ReactNode;
}) {
  const fam = report?.families;
  const built: RosterRow[] = rows.map((p, i) => ({
    p,
    natural: i,
    name: p.name.toLowerCase(),
    chains: p.chains.length,
    requests: p.requests,
    peak: p.peakRps ?? -1,
    err: p.errorRate ?? -1,
    replies: p.nodeErrorRate ?? -1,
    timeouts: p.protocolErrorRate ?? -1,
    p95: p.p95Ms ?? Infinity,
    rate: p.rateLimitHits ?? -1,
    uptime: p.uptime ?? -1,
    limited: p.rateLimitedMinutes ?? -1,
  }));
  const { sorted, sort, onSort } = useSort<RosterRow>(built, { key: "natural", dir: "asc" });

  return (
    <div className="gw-card" style={{ padding: 0, overflow: "hidden", marginBottom: 18 }}>
      <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>All providers</span>
        <Tip text="Every company behind your upstreams, across all your chains. Click a row to see its chains and methods below." />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--text-3)", display: "inline-flex", alignItems: "center", gap: 7 }}>
          {loading ? <Skel w={168} h={9} /> : <>{rows.length} provider{rows.length === 1 ? "" : "s"} · over {timeWindow}</>}
          {stale && <span style={{ color: "var(--warn)" }} title="The metrics store didn't answer the last refresh. These are the numbers from the read before it.">· couldn&apos;t refresh</span>}
          <Refreshing show={!loading && refreshing} label="Refreshing providers" />
        </span>
        {actions}
      </div>
      <div style={{ overflowX: "auto" }}>
        {/* The columns a reader decides on come first: on a laptop the last two scroll. */}
        <table className="gw-table gw-table--tight">
          <thead>
            <tr>
              <ThCol sortKey="name" sort={sort} onSort={onSort}>Provider</ThCol>
              <ThCol align="right" sortKey="chains" sort={sort} onSort={onSort}>Chains</ThCol>
              <ThCol align="right" sortKey="requests" sort={sort} onSort={onSort}>Requests</ThCol>
              <ThCol align="right" sortKey="err" sort={sort} onSort={onSort}>{two("Error", "rate")}</ThCol>
              <ThCol align="right" tip={TIP_REPLIES} sortKey="replies" sort={sort} onSort={onSort}>{two("Error", "replies")}</ThCol>
              <ThCol align="right" tip={TIP_RATE} sortKey="rate" sort={sort} onSort={onSort}>{two("Rate-limit", "hits")}</ThCol>
              <ThCol align="right" sortKey="p95" sort={sort} onSort={onSort}>p95</ThCol>
              <ThCol align="right" tip={TIP_UPTIME} sortKey="uptime" sort={sort} onSort={onSort}>Uptime</ThCol>
              <ThCol align="right" tip={TIP_LIMITED} sortKey="limited" sort={sort} onSort={onSort}>{two("Rate-limited", "time")}</ThCol>
              <ThCol align="right" tip={tipPeak(report?.peakWindowSec)} sortKey="peak" sort={sort} onSort={onSort}>{two("Peak", "req/s")}</ThCol>
              <ThCol align="right" tip={TIP_TIMEOUTS} sortKey="timeouts" sort={sort} onSort={onSort}>Timeouts</ThCol>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const p = r.p;
              const on = p.id === activeId;
              return (
                <tr key={p.id} onClick={() => onSelect(p.id)} style={{ cursor: "pointer", background: on ? "rgba(255,57,0,0.06)" : undefined, boxShadow: on ? "inset 2px 0 0 var(--brand)" : undefined }}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <UpstreamLogo id={p.id} size={18} />
                      <span style={{ fontSize: 13, fontWeight: on ? 700 : 500, whiteSpace: "nowrap" }}>{p.name}</span>
                      {p.accounts.length > 1 && (
                        <span title={`Node names: ${p.nodes.join(", ")}`}>
                          <Badge tone="muted">{p.accounts.length} accounts</Badge>
                        </span>
                      )}
                      {p.blockedNow && <Badge tone="err">Blocked</Badge>}
                    </div>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <span className="gw-mono gw-tnum" style={{ fontSize: 12 }} title={p.chains.map((c) => buildChainMetaByIndex(c.spec).name).join(", ")}>{p.chains.length}</span>
                  </td>
                  <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: p.requests > 0 ? "var(--text)" : "var(--text-4)" }}>{fmtNum(p.requests)}</span></td>
                  <td style={{ textAlign: "right" }}>{pctCell(p.errorRate)}</td>
                  <td style={{ textAlign: "right" }}>{pctCell(p.nodeErrorRate, fam?.nodeErrors ?? true)}</td>
                  <td style={{ textAlign: "right" }}>{numCell(p.rateLimitHits, fam?.rateLimit ?? true, "var(--warn)")}</td>
                  <td style={{ textAlign: "right" }}>{msCell(p.p95Ms, report?.latencyRead ?? true)}</td>
                  <td style={{ textAlign: "right" }}>{uptimeCell(p.uptime, report?.uptimeRead ?? true, p.downMinutes)}</td>
                  <td style={{ textAlign: "right" }}>{minutesCell(p.rateLimitedMinutes)}</td>
                  <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtRps(p.peakRps)}</span></td>
                  <td style={{ textAlign: "right" }}>{pctCell(p.protocolErrorRate, fam?.protocolErrors ?? true)}</td>
                </tr>
              );
            })}
            {loading && <SkelRows rows={6} cols={[
              { w: 140 }, { w: 30, align: "right" }, { w: 60, align: "right" }, { w: 50, align: "right" }, { w: 50, align: "right" },
              { w: 50, align: "right" }, { w: 52, align: "right" }, { w: 60, align: "right" }, { w: 44, align: "right" }, { w: 40, align: "right" }, { w: 40, align: "right" },
            ]} />}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={11} style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-4)", fontSize: 13 }}>No provider traffic in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {!loading && report?.unattributed && report.unattributed.requests > 0 && (
        <div style={{ padding: "9px 14px", borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--text-3)" }}
          title={report.unattributed.labels.length ? `Label values: ${report.unattributed.labels.join(", ")}` : undefined}>
          {fmtNum(report.unattributed.requests)} requests came from upstreams we can't name. Their numbers aren't in any row above.
        </div>
      )}
    </div>
  );
}

/* ── One provider ───────────────────────────────────────────────────────── */

interface ChainRow {
  c: ProviderChainStats;
  natural: number;
  chain: string;
  requests: number;
  share: number;
  err: number;
  replies: number;
  timeouts: number;
  p95: number;
  lag: number;
  rate: number;
  uptime: number;
  limited: number;
  others: number;
}

function ChainsTable({ detail, chainFilter, renderAction, onOpenUpstream }: {
  detail: ProviderDetailReport;
  chainFilter: string | null;
  renderAction?: (c: ProviderChainStats) => React.ReactNode;
  onOpenUpstream?: (ref: { endpointId: string; spec: string }) => void;
}) {
  const fam = detail.families;
  const rows = chainFilter ? detail.chains.filter((c) => c.spec === chainFilter) : detail.chains;
  const built: ChainRow[] = rows.map((c, i) => ({
    c,
    natural: i,
    chain: buildChainMetaByIndex(c.spec).name.toLowerCase(),
    requests: c.requests,
    share: c.share ?? -1,
    err: c.errorRate ?? -1,
    replies: c.nodeErrorRate ?? -1,
    timeouts: c.protocolErrorRate ?? -1,
    p95: c.p95Ms ?? Infinity,
    lag: c.behindSec ?? -1,
    rate: c.rateLimitHits ?? -1,
    uptime: c.uptime ?? -1,
    limited: c.rateLimitedMinutes ?? -1,
    // A chain it serves alone sorts below every comparison.
    others: c.others.providers > 0 ? (c.others.errorRate ?? -1) : -2,
  }));
  const { sorted, sort, onSort } = useSort<ChainRow>(built, { key: "natural", dir: "asc" });
  const cols = renderAction ? 13 : 12;

  return (
    <PMPanel title="Chains" tip="Every chain this provider serves for you. **Share** is its part of that chain's tries." full>
      <div style={{ overflowX: "auto", margin: "-12px -14px" }}>
        <table className="gw-table gw-table--tight">
          <thead>
            <tr>
              <ThCol sortKey="chain" sort={sort} onSort={onSort}>Chain</ThCol>
              <ThCol align="right" sortKey="requests" sort={sort} onSort={onSort}>Requests</ThCol>
              <ThCol align="right" sortKey="share" sort={sort} onSort={onSort}>Share</ThCol>
              <ThCol align="right" sortKey="err" sort={sort} onSort={onSort}>{two("Error", "rate")}</ThCol>
              <ThCol align="right" tip={TIP_OTHERS} sortKey="others" sort={sort} onSort={onSort}>{two("Others on", "this chain")}</ThCol>
              <ThCol align="right" tip={TIP_REPLIES} sortKey="replies" sort={sort} onSort={onSort}>{two("Error", "replies")}</ThCol>
              <ThCol align="right" tip={TIP_RATE} sortKey="rate" sort={sort} onSort={onSort}>{two("Rate-limit", "hits")}</ThCol>
              <ThCol align="right" sortKey="p95" sort={sort} onSort={onSort}>p95</ThCol>
              <ThCol align="right" tip="How far this provider's newest block is behind the chain's best, in seconds." sortKey="lag" sort={sort} onSort={onSort}>Behind</ThCol>
              <ThCol align="right" tip={TIP_UPTIME} sortKey="uptime" sort={sort} onSort={onSort}>Uptime</ThCol>
              <ThCol align="right" tip={TIP_LIMITED} sortKey="limited" sort={sort} onSort={onSort}>{two("Rate-limited", "time")}</ThCol>
              <ThCol align="right" tip={TIP_TIMEOUTS} sortKey="timeouts" sort={sort} onSort={onSort}>Timeouts</ThCol>
              {renderAction && <th style={STICKY_HEAD} />}
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ c }) => (
              <tr key={`${c.node}|${c.spec}`}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <ChainBadge spec={c.spec} size={16} />
                    {onOpenUpstream ? (
                      <button onClick={() => onOpenUpstream({ endpointId: c.node, spec: c.spec })} title="Open this upstream in the Upstreams tab"
                        style={{ border: "none", background: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12, color: "var(--text-2)", textAlign: "left", whiteSpace: "nowrap" }}>
                        {buildChainMetaByIndex(c.spec).name}
                      </button>
                    ) : (
                      <span style={{ fontSize: 12, color: "var(--text-2)", whiteSpace: "nowrap" }}>{buildChainMetaByIndex(c.spec).name}</span>
                    )}
                    {c.account && <span className="gw-mono" style={{ fontSize: 10, color: "var(--text-4)", whiteSpace: "nowrap" }}>{c.node}</span>}
                    {c.role && <Badge tone={c.role}>{c.role === "primary" ? "Primary" : "Backup"}</Badge>}
                    {c.blockedNow && <span title="The router has stopped sending this provider requests on this chain for now."><Badge tone="err">Blocked</Badge></span>}
                  </div>
                </td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: c.requests > 0 ? "var(--text)" : "var(--text-4)" }}>{fmtNum(c.requests)}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--text-3)" }}>{c.share != null ? `${(c.share * 100).toFixed(0)}%` : "—"}</span></td>
                <td style={{ textAlign: "right" }}>{pctCell(c.errorRate)}</td>
                <td style={{ textAlign: "right" }}>{othersCell(c.others)}</td>
                <td style={{ textAlign: "right" }}>{pctCell(c.nodeErrorRate, fam.nodeErrors)}</td>
                <td style={{ textAlign: "right" }}>
                  {fam.rateLimit && c.rateLimitHits == null ? (
                    <span style={{ fontSize: 12, color: "var(--text-4)" }} title="Hold-offs carry no chain label on this deployment - see the provider total above.">—</span>
                  ) : numCell(c.rateLimitHits, fam.rateLimit, "var(--warn)")}
                </td>
                <td style={{ textAlign: "right" }}>{msCell(c.p95Ms, detail.latencyRead)}</td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: tipLagColor(c.behindSec) }}>{fmtLag(c.behindSec)}</span></td>
                <td style={{ textAlign: "right" }}>{uptimeCell(c.uptime, detail.uptimeRead, c.downMinutes)}</td>
                <td style={{ textAlign: "right" }}>{minutesCell(c.rateLimitedMinutes)}</td>
                <td style={{ textAlign: "right" }}>{pctCell(c.protocolErrorRate, fam.protocolErrors)}</td>
                {renderAction && <td style={STICKY_CELL}>{renderAction(c)}</td>}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={cols} style={{ padding: "20px 16px", textAlign: "center", color: "var(--text-4)", fontSize: 13 }}>
                {chainFilter ? `This provider doesn't serve ${buildChainMetaByIndex(chainFilter).name}.` : "No chains in this window."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </PMPanel>
  );
}

interface MethodRow {
  m: ProviderMethodStats;
  natural: number;
  method: string;
  chain: string;
  requests: number;
  failed: number;
  err: number;
  replies: number;
  p50: number;
  p95: number;
  p99: number;
}

function MethodsTable({ detail, chainFilter }: { detail: ProviderDetailReport; chainFilter: string | null }) {
  const PAGE = 12;
  const [page, setPage] = useState(0);
  const rows = chainFilter ? detail.methods.filter((m) => m.spec === chainFilter) : detail.methods;
  const built: MethodRow[] = rows.map((m, i) => ({
    m,
    natural: i,
    method: m.method.toLowerCase(),
    chain: buildChainMetaByIndex(m.spec).name.toLowerCase(),
    requests: m.requests,
    failed: m.failed,
    err: m.errorRate ?? -1,
    replies: m.nodeErrors ?? -1,
    p50: m.p50Ms ?? Infinity,
    p95: m.p95Ms ?? Infinity,
    p99: m.p99Ms ?? Infinity,
  }));
  const { sorted, sort, onSort } = useSort<MethodRow>(built, { key: "natural", dir: "asc" });
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE));
  const cur = Math.min(page, pageCount - 1);
  useEffect(() => { setPage(0); }, [rows.length, sort.key, sort.dir]);
  const latTip = !detail.latencyRead
    ? LATENCY_NOT_READ
    : detail.methodLatency
      ? undefined
      : "This router build's latency histogram has no method label, so latency per method isn't available.";

  return (
    <PMPanel title="Methods" tip="Every method sent to this provider, worst first. **Failed** counts requests this provider didn't answer - the router may still have answered the caller from another provider. **Error replies** counts the ones it answered with an error." full>
      <div style={{ overflowX: "auto", margin: "-12px -14px" }}>
        <table className="gw-table gw-table--tight">
          <thead>
            <tr>
              <ThCol sortKey="method" sort={sort} onSort={onSort}>Method</ThCol>
              <ThCol sortKey="chain" sort={sort} onSort={onSort}>Chain</ThCol>
              <ThCol align="right" sortKey="requests" sort={sort} onSort={onSort}>Requests</ThCol>
              <ThCol align="right" sortKey="failed" sort={sort} onSort={onSort}>Failed</ThCol>
              <ThCol align="right" sortKey="err" sort={sort} onSort={onSort}>{two("Error", "rate")}</ThCol>
              <ThCol align="right" tip={TIP_REPLIES} sortKey="replies" sort={sort} onSort={onSort}>{two("Error", "replies")}</ThCol>
              <ThCol align="right" tip={latTip} sortKey="p50" sort={sort} onSort={onSort}>p50</ThCol>
              <ThCol align="right" tip={latTip} sortKey="p95" sort={sort} onSort={onSort}>p95</ThCol>
              <ThCol align="right" tip={latTip} sortKey="p99" sort={sort} onSort={onSort}>p99</ThCol>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(cur * PAGE, cur * PAGE + PAGE).map(({ m }) => (
              <tr key={`${m.node}|${m.spec}|${m.method}`}>
                <td><span className="gw-mono" style={{ fontSize: 12 }}>{m.method}</span></td>
                <td>
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <ChainBadge spec={m.spec} size={14} />
                    <span style={{ fontSize: 12, color: "var(--text-2)" }}>{buildChainMetaByIndex(m.spec).name}</span>
                  </span>
                </td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtNum(m.requests)}</span></td>
                <td style={{ textAlign: "right" }}>{numCell(m.failed, true, "var(--err)")}</td>
                <td style={{ textAlign: "right" }}>{pctCell(m.errorRate)}</td>
                <td style={{ textAlign: "right" }}>{numCell(m.nodeErrors, detail.families.nodeErrors, "var(--err)")}</td>
                <td style={{ textAlign: "right" }}>{msCell(m.p50Ms, detail.latencyRead)}</td>
                <td style={{ textAlign: "right" }}>{msCell(m.p95Ms, detail.latencyRead)}</td>
                <td style={{ textAlign: "right" }}>{msCell(m.p99Ms, detail.latencyRead)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} style={{ padding: "20px 16px", textAlign: "center", color: "var(--text-4)", fontSize: 13 }}>No methods in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "9px 0 0" }}>
          <span style={{ fontSize: 11, color: "var(--text-4)" }}>{cur * PAGE + 1}-{Math.min(rows.length, cur * PAGE + PAGE)} of {rows.length}</span>
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={cur === 0} className="gw-btn gw-btn--ghost" style={{ padding: "3px 9px", fontSize: 12, opacity: cur === 0 ? 0.4 : 1 }}>Prev</button>
          <span style={{ fontSize: 11, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>{cur + 1} / {pageCount}</span>
          <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={cur >= pageCount - 1} className="gw-btn gw-btn--ghost" style={{ padding: "3px 9px", fontSize: 12, opacity: cur >= pageCount - 1 ? 0.4 : 1 }}>Next</button>
        </div>
      )}
    </PMPanel>
  );
}

/* ── The tab ────────────────────────────────────────────────────────────── */

/** A provider's numbers cover minutes to weeks: a read a minute is plenty, and each costs the store a dozen queries. */
const REFRESH_MS = 60_000;

export function ProvidersTab({ timeWindow, chainFilter, selectedId, onSelect, rosterActions, renderChainAction, onOpenUpstream, onOpenReport }: {
  timeWindow: MetricWindow;
  chainFilter: string | null;
  /** The provider the page shows; null = every provider, side by side. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Extra controls in the roster header (the CSV export). */
  rosterActions?: React.ReactNode;
  /** A per-chain action cell (the provider report). */
  renderChainAction?: (provider: ProviderSummary, chain: ProviderChainStats) => React.ReactNode;
  /** A chain row's name: opens that upstream in the Upstreams tab. */
  onOpenUpstream?: (ref: { endpointId: string; spec: string }) => void;
  /** A graph bar: opens the provider report on that stretch. */
  onOpenReport?: (target: ReportTarget) => void;
}) {
  const { scopeQ } = useFilters();
  const listRes = useApi<ProvidersReport>(`/api/metrics/providers?window=${timeWindow}${scopeQ}`, REFRESH_MS);
  const report = listRes.data;
  const rows = useMemo(() => {
    const all = report?.providers ?? [];
    return chainFilter ? all.filter((p) => p.chains.some((c) => c.spec === chainFilter)) : all;
  }, [report, chainFilter]);

  const sel = selectedId ? (report?.providers.find((p) => p.id === selectedId) ?? null) : null;
  const detailRes = useApi<ProviderDetailReport>(
    sel ? `/api/metrics/provider-detail?provider=${encodeURIComponent(sel.id)}&window=${timeWindow}${scopeQ}` : null,
    REFRESH_MS,
  );
  const detail = detailRes.data;
  const fam = report?.families;
  const avgRps = sel ? sel.requests / WINDOWS[timeWindow].rangeSeconds : null;

  // Never an empty table for a read that didn't happen.
  if (listRes.error && !report) {
    return (
      <div className="gw-card" style={{ padding: "40px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, color: "var(--text-3)" }}>The providers couldn&apos;t be loaded.</span>
        <span style={{ fontSize: 12, color: "var(--text-4)", maxWidth: 520, lineHeight: 1.6 }}>
          The metrics store didn&apos;t answer. This tab tries again on its next refresh.
        </span>
      </div>
    );
  }

  return (
    <div>
      {chainFilter && (
        <div style={{ fontSize: 12, color: "var(--text-3)", margin: "-8px 0 12px" }}>
          Providers serving {buildChainMetaByIndex(chainFilter).name}. Totals in the list cover all their chains.
        </div>
      )}
      {!selectedId && (
        <ProvidersRoster report={report} rows={rows} activeId={null} onSelect={onSelect} timeWindow={timeWindow}
          loading={listRes.isLoading} refreshing={listRes.isValidating} stale={!!listRes.error} actions={rosterActions} />
      )}

      {selectedId && !sel && !listRes.isLoading && (
        <div className="gw-card" style={{ padding: "32px 24px", textAlign: "center", fontSize: 13, color: "var(--text-3)" }}>
          No traffic to this provider in this window.{" "}
          <button onClick={() => onSelect(null)} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>See all providers</button>
        </div>
      )}

      {sel && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 14px" }}>
            <UpstreamLogo id={sel.id} size={20} />
            <span style={{ fontSize: 16, fontWeight: 700 }}>{sel.name}</span>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>· {sel.chains.length} chain{sel.chains.length === 1 ? "" : "s"}{sel.accounts.length > 1 ? ` · ${sel.accounts.length} accounts` : ""}</span>
            {sel.blockedNow && <Badge tone="err">Blocked now</Badge>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 12 }}>
            <PMStat label="Requests" tip={tipPeak(report?.peakWindowSec)}>
              {sel.requests > 0 ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{fmtNum(sel.requests)}</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>
                    avg {fmtRps(avgRps)} req/s · peak {fmtRps(sel.peakRps)} req/s
                  </div>
                </>
              ) : <PMNoVal />}
            </PMStat>
            <PMStat label="Error rate" tip="Tries to this provider that **failed**, before the router retried or failed over.">
              {sel.errorRate != null ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color: errRateColor(sel.errorRate * 100, "var(--ok)") }}>{(sel.errorRate * 100).toFixed(2)}%</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>
                    {fam?.nodeErrors && sel.nodeErrorRate != null
                      ? <>and {(sel.nodeErrorRate * 100).toFixed(2)}% answered with an error</>
                      : <>error replies not counted by this router</>}
                  </div>
                </>
              ) : <PMNoVal />}
            </PMStat>
            <PMStat label="Latency">
              {sel.p95Ms != null ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{Math.round(sel.p95Ms)}<span style={{ fontSize: 13, color: "var(--text-3)", fontWeight: 500 }}> ms</span></div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>p95 · all chains</div>
                </>
              ) : report?.latencyRead === false ? (
                <div style={{ fontSize: 12, color: "var(--text-4)", paddingTop: 4, lineHeight: 1.5 }}>Not read for windows longer than a day</div>
              ) : <PMNoVal />}
            </PMStat>
            <PMStat label="Rate-limit hits" tip={TIP_RATE}>
              {!fam?.rateLimit ? (
                <div style={{ fontSize: 13, color: "var(--text-4)", paddingTop: 4 }} title={NOT_EMITTED}>Not emitted</div>
              ) : (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color: (sel.rateLimitHits ?? 0) > 0 ? "var(--warn)" : "var(--text)" }}>{fmtNum(sel.rateLimitHits)}</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>
                    {sel.rateLimitedMinutes != null
                      ? <>{fmtNum(sel.rateLimitedMinutes)} min rate-limited · {timeWindow}</>
                      : <>"too many requests" hold-offs · {timeWindow}</>}
                  </div>
                </>
              )}
            </PMStat>
            <PMStat label="Uptime" tip={TIP_UPTIME}>
              {sel.uptime != null ? (
                <>
                  <div className="gw-mono gw-tnum" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color: uptimeColorFrac(sel.uptime) }}>{(sel.uptime * 100).toFixed(2)}%</div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>
                    {fmtNum(sel.downMinutes ?? 0)} down minute{sel.downMinutes === 1 ? "" : "s"} · rate limits not counted
                  </div>
                </>
              ) : report?.uptimeRead === false ? (
                <div style={{ fontSize: 12, color: "var(--text-4)", paddingTop: 4, lineHeight: 1.5 }}>Not read for windows longer than a day</div>
              ) : <PMNoVal />}
            </PMStat>
          </div>

          <ProviderCharts providerId={sel.id} providerName={sel.name} timeWindow={timeWindow} onOpenReport={onOpenReport} />

          {detailRes.error && !detail ? (
            <div className="gw-card" style={{ padding: 16, fontSize: 12, color: "var(--text-3)" }}>
              The chains and methods couldn&apos;t be loaded - the metrics store didn&apos;t answer. This tab tries again on its next refresh.
            </div>
          ) : detail ? (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
              <ChainsTable detail={detail} chainFilter={chainFilter} onOpenUpstream={onOpenUpstream}
                renderAction={renderChainAction ? (c) => renderChainAction(sel, c) : undefined} />
              <MethodsTable detail={detail} chainFilter={chainFilter} />
            </div>
          ) : (
            <div className="gw-card" style={{ padding: 16 }}><Skel w={240} h={10} /></div>
          )}
        </>
      )}
    </div>
  );
}
