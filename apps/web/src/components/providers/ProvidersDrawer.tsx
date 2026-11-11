"use client";

/* The providers list beside the sidebar, as the chains list sits beside it on
 * Metrics: one row per provider with its requests and error rate, problems
 * first, and a search. "All providers" at the top is the comparison table;
 * a row is that provider's page. Rows that are no provider company - a
 * chain's free public node, or a node of the customer's own - sit apart at
 * the bottom: their numbers are real, but there is nobody to send a report to. */

import { useState } from "react";
import { PROVIDER_COMPANIES, WINDOWS, type MetricWindow, type ProviderSummary, type ProvidersReport } from "@sr/shared";
import { IconSearch } from "@/components/gateway/icons";
import { UpstreamLogo } from "@/components/upstreams/UpstreamLogo";
import { errRateColor } from "@/lib/colors";
import { fmtNum } from "@/lib/format";

const KNOWN = new Set(PROVIDER_COMPANIES.map((c) => c.id));

export function ProvidersDrawer({ report, loading, selectedId, onSelect, timeWindow }: {
  report: ProvidersReport | undefined;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  timeWindow: MetricWindow;
}) {
  const [query, setQuery] = useState("");
  const all = report?.providers ?? [];
  const q = query.trim().toLowerCase();
  const shown = q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.id.includes(q)) : all;
  const companies = shown.filter((p) => KNOWN.has(p.id));
  const others = shown.filter((p) => !KNOWN.has(p.id));
  const blocked = all.filter((p) => p.blockedNow).length;
  // Every provider's failed tries over every try - the same ratio as each row's.
  const tries = all.reduce((a, p) => a + p.requests, 0);
  const failed = all.reduce((a, p) => a + (p.errorRate ?? 0) * p.requests, 0);
  const allPct = tries > 0 ? (failed / tries) * 100 : null;

  // A plain click picks here; a new tab or window follows the link.
  const plain = (e: React.MouseEvent) => !(e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
  const pick = (id: string | null) => (e: React.MouseEvent) => {
    if (!plain(e)) return;
    e.preventDefault();
    onSelect(id);
  };

  return (
    <aside className="gw-chains">
      <div className="gw-chains__head">
        <span className="title">Providers</span>
      </div>
      <label className="gw-chains__search">
        <IconSearch size={13} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search providers" aria-label="Search providers"
          onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search" title="Clear search">×</button>
        )}
      </label>
      <div className="gw-chains__cols" aria-hidden>
        <span>Provider</span>
        <span>Error rate</span>
      </div>
      <nav className="gw-chains__list" aria-label="Providers">
        <a href="/providers" onClick={pick(null)} className={`gw-chain-row${selectedId === null ? " active" : ""}`} aria-current={selectedId === null ? "page" : undefined}>
          <span className="gw-chain-row__all" aria-hidden>
            <span style={{ background: "var(--brand)" }} /><span style={{ background: "var(--text-3)" }} /><span style={{ background: "var(--text-4)" }} />
          </span>
          <span className="meta">
            <span className="name">All providers</span>
            <span className="sub">
              {loading ? "…" : `${all.length} provider${all.length === 1 ? "" : "s"}`}
              {blocked > 0 && <span style={{ color: "var(--err)" }}> · {blocked} blocked</span>}
            </span>
          </span>
          <ErrRate pct={loading ? null : allPct} />
          <span className="dot" style={{ visibility: "hidden" }} />
        </a>
        {companies.length > 0 && (
          <div className="gw-chains__group">
            {others.length > 0 && <div className="gw-chains__group-label">Provider companies</div>}
            {companies.map((p) => <Row key={p.id} p={p} active={selectedId === p.id} onPick={pick(p.id)} />)}
          </div>
        )}
        {others.length > 0 && (
          <div className="gw-chains__group">
            <div className="gw-chains__group-label" title="A chain's free public node, or a node of your own. Their numbers are real, but there is no provider to report to.">
              Not a provider company
            </div>
            {others.map((p) => <Row key={p.id} p={p} active={selectedId === p.id} onPick={pick(p.id)} />)}
          </div>
        )}
        {q && shown.length === 0 && <div className="gw-chains__empty">No provider matches &ldquo;{query}&rdquo;.</div>}
        {!loading && !q && all.length === 0 && <div className="gw-chains__empty">No provider traffic in this window.</div>}
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

function Row({ p, active, onPick }: { p: ProviderSummary; active: boolean; onPick: (e: React.MouseEvent) => void }) {
  const status = p.blockedNow ? "Blocked from routing now" : "Routing";
  return (
    <a href={`/providers?provider=${encodeURIComponent(p.id)}`} onClick={onPick} aria-current={active ? "page" : undefined}
      className={`gw-chain-row${active ? " active" : ""}${p.requests === 0 ? " muted" : ""}`}>
      <UpstreamLogo id={p.id} size={18} />
      <span className="meta">
        <span className="name">{p.name}</span>
        <span className="sub">
          {fmtNum(p.requests)} requests · {p.chains.length} chain{p.chains.length === 1 ? "" : "s"}
        </span>
      </span>
      <ErrRate pct={p.errorRate == null ? null : p.errorRate * 100} />
      {/* Red only when the router has stopped sending it requests. */}
      <span className="dot" role="img" aria-label={status} title={status}
        style={{ background: p.blockedNow ? "var(--err)" : "transparent", visibility: p.blockedNow ? "visible" : "hidden" }} />
    </a>
  );
}
