"use client";

/* ProviderReport — the provider report sheet and the export buttons.
 * The report is the text a customer pastes into a complaint to a provider:
 * chain, environment, URL (keys masked), methods, problem, start and end,
 * affected volume, example requests. Fields the router doesn't record say
 * "Not captured" in the text itself, so a pasted report never implies more
 * than we know. Live data: /api/providers/report (+ .csv) and
 * /api/providers/export.csv. */

import { useState } from "react";
import { buildChainMetaByIndex, WINDOWS, type MetricWindow, type ProviderReport } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { apiDownload } from "@/lib/api-client";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { SideSheet } from "@/components/gateway/SideSheet";
import { CopyButton } from "@/components/gateway/CopyButton";
import { Skel } from "@/components/gateway/Skel";
import { ProvidersTab } from "./ProvidersTab";

/** `datetime-local` value (local time) ↔ unix ms. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => new Date(v).getTime();

export function ReportButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="gw-btn gw-btn--ghost" onClick={onClick} style={{ padding: "3px 9px", fontSize: 11 }}
      title="A report you can paste into a complaint to this provider">
      Report
    </button>
  );
}

export function ExportButton({ timeWindow }: { timeWindow: MetricWindow }) {
  const { scopeQ } = useFilters();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, marginLeft: 10 }}>
      {error && <span style={{ fontSize: 11, color: "var(--err)" }}>{error}</span>}
      <button className="gw-btn gw-btn--ghost" disabled={busy} style={{ padding: "3px 9px", fontSize: 11 }}
        title="Every provider × chain for this window"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiDownload(`/api/providers/export.csv?window=${timeWindow}${scopeQ}`, `providers-${timeWindow}.csv`);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Export failed");
          } finally {
            setBusy(false);
          }
        }}>
        {busy ? "Exporting…" : "Download CSV"}
      </button>
    </span>
  );
}

export function ProviderReportSheet({ target, timeWindow, onClose }: {
  target: { providerId: string; providerName: string; spec: string } | null;
  timeWindow: MetricWindow;
  onClose: () => void;
}) {
  const { scopeQ } = useFilters();
  // The range starts as the page window; the reader can narrow it to the incident.
  const [range, setRange] = useState<{ from: number; to: number }>(() => {
    const to = Date.now();
    return { from: to - WINDOWS[timeWindow].rangeSeconds * 1000, to };
  });
  const [draft, setDraft] = useState(range);
  const q = target
    ? `provider=${encodeURIComponent(target.providerId)}&spec=${encodeURIComponent(target.spec)}&from=${range.from}&to=${range.to}${scopeQ}`
    : null;
  const res = useApi<ProviderReport>(q ? `/api/providers/report?${q}` : null, 0);
  const r = res.data;
  const chainName = target ? buildChainMetaByIndex(target.spec).name : "";
  const noFailures = r && r.failedTries === 0 && !r.errorReplies;

  return (
    <SideSheet open={!!target} onClose={onClose} wide
      title={target ? `Report for ${target.providerName} - ${chainName}` : ""}
      sub="Paste this into your complaint to the provider. Fields we don't record say so."
      footer={
        r && !noFailures ? (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <CopyButton text={r.text} label="Copy text" />
            <button className="gw-btn gw-btn--ghost" style={{ padding: "3px 9px", fontSize: 11 }}
              onClick={() => q && void apiDownload(`/api/providers/report.csv?${q}`, "provider-report.csv")}>
              Download CSV
            </button>
          </div>
        ) : undefined
      }>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <label style={{ fontSize: 11, color: "var(--text-3)", display: "grid", gap: 4 }}>
          From
          <input type="datetime-local" className="gw-input" value={toLocalInput(draft.from)}
            onChange={(e) => setDraft((d) => ({ ...d, from: fromLocalInput(e.target.value) }))} />
        </label>
        <label style={{ fontSize: 11, color: "var(--text-3)", display: "grid", gap: 4 }}>
          To
          <input type="datetime-local" className="gw-input" value={toLocalInput(draft.to)}
            onChange={(e) => setDraft((d) => ({ ...d, to: fromLocalInput(e.target.value) }))} />
        </label>
        <button className="gw-btn" style={{ padding: "5px 12px", fontSize: 12 }}
          disabled={!(draft.from < draft.to) || (draft.from === range.from && draft.to === range.to)}
          onClick={() => setRange(draft)}>
          Update
        </button>
      </div>

      {res.error && (
        <div style={{ fontSize: 13, color: "var(--err)" }}>{res.error instanceof Error ? res.error.message : "The report couldn't be built."}</div>
      )}
      {!r && !res.error && <Skel w={320} h={10} />}
      {noFailures && (
        <div style={{ fontSize: 13, color: "var(--text-3)", padding: "16px 0" }}>
          No failed requests and no error replies to {target?.providerName} on {chainName} in this range.
        </div>
      )}
      {r && !noFailures && (
        <>
          {r.logs !== "ok" && (
            <div style={{ fontSize: 12, color: "var(--warn)", marginBottom: 10 }}>
              The router's logs couldn't be read, so the start and end are the range, and there are no example requests.
            </div>
          )}
          <pre className="gw-mono" style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.55, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 8, padding: "12px 14px", margin: 0, color: "var(--text)" }}>
            {r.text}
          </pre>
        </>
      )}
    </SideSheet>
  );
}

/** The Providers tab with its export and per-chain report wired in. */
export function ProvidersWithReports({ timeWindow, chainFilter, onOpenUpstream }: {
  timeWindow: MetricWindow;
  chainFilter: string | null;
  onOpenUpstream?: (ref: { endpointId: string; spec: string }) => void;
}) {
  const [target, setTarget] = useState<{ providerId: string; providerName: string; spec: string } | null>(null);
  return (
    <>
      <ProvidersTab timeWindow={timeWindow} chainFilter={chainFilter} onOpenUpstream={onOpenUpstream}
        rosterActions={<ExportButton timeWindow={timeWindow} />}
        renderChainAction={(p, c) =>
          c.requests > 0 ? <ReportButton onClick={() => setTarget({ providerId: p.id, providerName: p.name, spec: c.spec })} /> : null
        } />
      <ProviderReportSheet key={target ? `${target.providerId}|${target.spec}` : "none"} target={target}
        timeWindow={timeWindow} onClose={() => setTarget(null)} />
    </>
  );
}
