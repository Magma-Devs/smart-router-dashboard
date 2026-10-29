"use client";

/* An opened row of either request list - the Errors tab's and the
 * Transactions tab's - as one breakdown in three parts:
 *
 *   Request    the facts the router wrote about the call
 *   Tries      one line per try at a provider: result, time, the error by
 *              name and its source
 *   Response   what the client received: returned by, status, retries, next step
 *
 * One statement per error, on the try it happened on: its name (from @sr/shared's
 * table, explainRouterError) and its source. The router's code, the node's code and
 * the provider's own words sit behind it on hover, except where the source is
 * undetermined and the provider's words are the only explanation. Orange marks
 * the one thing that reached the client. */

import {
  ERROR_SOURCE_LABELS,
  explainRouterError,
  type CallFacts,
  type ErrorSource,
  type RelayAttempt,
  type RouterErrorCode,
} from "@sr/shared";
import { CopyButton } from "@/components/gateway/CopyButton";
import { ExplorerBlockLink } from "@/components/gateway/ExplorerLink";
import { fmtComma } from "@/lib/format";
import { codeWords, fmtTook, fmtWhen, realCode, RequestLogsLink } from "./request-log";

/** What each source means, on hover. */
export const SOURCE_HINTS: Record<ErrorSource, string> = {
  request: "The request itself: how it was built or sent. Any provider would answer the same.",
  chain: "The chain's rules or state. Every healthy, up-to-date provider would answer the same.",
  provider: "One provider, or the path to it. Another provider may answer differently.",
  router: "The router itself, or no provider available for the request.",
  unclear: "The code doesn't determine the source. The provider's message does.",
};

/** The error's name as a label: NODE_DATA_NOT_HELD → "Data not held". */
export function errorName(code: string): string {
  const w = codeWords(code);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** "Source: Provider". */
export function SourceTag({ source }: { source: ErrorSource }) {
  return (
    <span title={SOURCE_HINTS[source]} style={{ fontSize: 11, color: "var(--text-3)", whiteSpace: "nowrap" }}>
      Source: <span style={{ color: "var(--text)", fontWeight: 500 }}>{ERROR_SOURCE_LABELS[source]}</span>
    </span>
  );
}

/** The error by name, in red. The router's code, the node's code, the meaning and the provider's words on hover. */
function ErrorChip({ code, entry, nodeCode, message }: { code: string; entry: RouterErrorCode | null; nodeCode?: number; message?: string | null }) {
  const title = [
    `${code}${nodeCode != null ? ` · node ${nodeCode}` : ""}`,
    entry?.meaning,
    message,
  ].filter(Boolean).join("\n\n");
  return (
    <span title={title}
      style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, background: "color-mix(in srgb, var(--err) 12%, transparent)", color: "var(--err)", whiteSpace: "nowrap" }}>
      {errorName(code)}
    </span>
  );
}

const fmtBytes = (n: number) => (n < 1024 ? `${fmtComma(n)} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function Part({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-4)" }}>{title}</span>
        {aside && <span style={{ fontSize: 11, color: "var(--text-4)" }}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const box = (returned = false): React.CSSProperties => ({
  border: `1px solid ${returned ? "var(--warn)" : "var(--line)"}`,
  boxShadow: returned ? "inset 3px 0 0 var(--warn)" : undefined,
  borderRadius: 8,
  background: "var(--surface)",
  padding: "8px 12px",
  minWidth: 0,
});

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 11.5, color: "var(--text-4)", whiteSpace: "nowrap" }}>
      {label} <span className="gw-mono" style={{ color: "var(--text-2)" }}>{children}</span>
    </span>
  );
}

const RESULT: Record<RelayAttempt["outcome"], { mark: string; words: string; color: string }> = {
  ok: { mark: "✓", words: "Succeeded", color: "var(--ok)" },
  failed: { mark: "✗", words: "Failed", color: "var(--err)" },
  skipped: { mark: "↷", words: "Skipped", color: "var(--text-3)" },
  cancelled: { mark: "⊘", words: "Cancelled", color: "var(--text-3)" },
  "no-result": { mark: "…", words: "No response", color: "var(--text-3)" },
};

/** One try, on one line: provider, result, time, the error and its source. */
function TryRow({ a, n, together }: { a: RelayAttempt; n: number; together: boolean }) {
  const code = a.outcome === "failed" ? realCode(a) : null;
  const entry = code ? explainRouterError(code) : null;
  const r = RESULT[a.outcome];
  const words = a.outcome === "no-result" && a.replied ? "Succeeded" : r.words;
  // The provider's words, shown only where nothing else explains the error - no code, or an undetermined
  // source - and only when they say more than the error's name.
  const ownWords = a.outcome === "failed" && a.message && (!code || entry?.source === "unclear")
    && !(code && a.message.toLowerCase().includes(codeWords(code))) ? a.message : null;
  return (
    <div style={box(a.replied)}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
        <span className="gw-mono gw-tnum" style={{ fontSize: 11, color: "var(--text-4)", minWidth: 12 }}>{n}</span>
        <span className="gw-mono" style={{ fontSize: 12.5, color: "var(--text)" }}>{a.upstream}</span>
        <span style={{ fontSize: 12, color: r.color, whiteSpace: "nowrap" }}>{r.mark} {words}</span>
        {a.endMs != null && a.outcome !== "skipped" && <span className="gw-mono gw-tnum" style={{ fontSize: 11.5, color: "var(--text-3)" }}>{fmtTook(a.endMs - a.atMs)}</span>}
        {together && <span style={{ fontSize: 11, color: "var(--text-4)" }}>parallel</span>}
        {code && <ErrorChip code={code} entry={entry} nodeCode={a.nodeCode} message={a.message} />}
        {entry && <SourceTag source={entry.source} />}
        <span style={{ flex: 1 }} />
        {a.replied && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--warn)", whiteSpace: "nowrap" }}>Returned to client</span>}
      </div>
      {(ownWords || a.note) && (
        <div className={ownWords ? "gw-mono" : undefined} title={ownWords ?? undefined}
          style={{ marginTop: 4, marginLeft: 22, fontSize: 11.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {ownWords ?? a.note}
        </div>
      )}
    </div>
  );
}

/** What reached the client: the try whose reply went back, or the router's own answer. */
export type FinalAnswer =
  /** `code`: the reply's own code, where the tab has it and the try doesn't (a transaction's refusal). */
  | { from: "provider"; attempt: RelayAttempt; code?: string | null }
  | { from: "router"; code: string | null }
  | null;

export interface BreakdownProps {
  /** The request's chain, where the logs name one: its block numbers link to that chain's explorer. */
  spec: string | null;
  chain: string;
  /** On hover: every chain the request could be on, when the logs don't name it. */
  chainTitle?: string;
  method: string;
  time: number;
  guid: string;
  tookMs: number | null;
  facts: CallFacts;
  attempts: RelayAttempt[];
  final: FinalAnswer;
  /** The response's status: a word in its colour, and an optional detail ("after 1 failed try"). */
  status: { label: string; color: string; detail?: string | null };
  /** Why the router stopped retrying, when it stopped short of an answer. */
  retries?: string | null;
  /** A transaction: an error that may have gone through says so. */
  isWrite: boolean;
  /** More rows for the response: a transaction's hash, an on-chain error, why a result is unknown. */
  extra?: { label: string; value: React.ReactNode }[];
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span style={{ fontSize: 11.5, color: "var(--text-4)", whiteSpace: "nowrap" }}>{label}</span>
      <div style={{ fontSize: 12.5, color: "var(--text-2)", minWidth: 0, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>{children}</div>
    </>
  );
}

export function RequestBreakdown(p: BreakdownProps) {
  const together = (a: RelayAttempt) => p.attempts.filter((x) => x.batch === a.batch).length > 1;
  const finalCode =
    p.final?.from === "provider" ? (p.final.attempt.outcome === "failed" ? realCode(p.final.attempt) : null) ?? p.final.code ?? null
      : p.final?.from === "router" ? p.final.code
        : null;
  const entry = finalCode ? explainRouterError(finalCode) : null;
  const routerAnswered = p.final?.from === "router";
  const facts = p.facts;
  // A block number links to the chain's explorer where the catalog has a proven block page, as the Routers table's heights do.
  const block = (n: number) => (p.spec ? <ExplorerBlockLink spec={p.spec} block={n}>{fmtComma(n)}</ExplorerBlockLink> : fmtComma(n));
  const providers = new Set(p.attempts.map((a) => a.upstream)).size;
  const blockAhead = finalCode && facts.requestedBlock != null && facts.seenBlock != null && facts.requestedBlock > facts.seenBlock;
  return (
    <div style={{ display: "grid", gap: 12, padding: "6px 4px 10px" }}>
      <Part title="Request">
        <div style={{ ...box(), display: "flex", flexWrap: "wrap", columnGap: 16, rowGap: 4, alignItems: "center" }}>
          <span className="gw-mono" style={{ fontSize: 12.5, color: "var(--text)" }}>{p.method}</span>
          <span title={p.chainTitle} style={{ fontSize: 12, color: "var(--text-3)" }}>{p.chain}</span>
          <Fact label="At">{fmtWhen(p.time)}</Fact>
          <Fact label="Duration">{fmtTook(p.tookMs)}</Fact>
          {/* The request's one ID is Smart Router's. The X-Request-Id, X-Task-Id and X-Tx-Id headers the
              router also logs aren't shown: behind the gateway the first is the gateway's own ID for every request. */}
          <span title="The ID Smart Router gives every request: its GUID in the router's logs, and the Lava-Guid header on the reply"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-4)" }}>
            Smart Router request ID <span className="gw-mono" style={{ color: "var(--text-2)" }}>{p.guid}</span> <CopyButton text={p.guid} />
            <RequestLogsLink id={p.guid} startMs={p.time} tookMs={p.tookMs} />
          </span>
          {facts.customer && <Fact label="Customer">{facts.customer}</Fact>}
          {facts.requestBytes != null && <Fact label="Size">{fmtBytes(facts.requestBytes)}</Fact>}
          {facts.requestedBlock != null && <Fact label="Requested block">{block(facts.requestedBlock)}</Fact>}
          {facts.seenBlock != null && <Fact label="Router's latest block">{block(facts.seenBlock)}</Fact>}
        </div>
      </Part>

      <Part title="Tries" aside={p.attempts.length ? `${p.attempts.length} · ${providers} ${providers === 1 ? "provider" : "providers"}` : "none logged"}>
        {p.attempts.map((a, i) => <TryRow key={i} a={a} n={i + 1} together={together(a)} />)}
      </Part>

      <Part title="Response">
        <div style={{ ...box(routerAnswered), display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 16, rowGap: 6, alignItems: "center" }}>
          <Row label="Returned by">
            <span className="gw-mono" style={{ color: "var(--text)" }}>{routerAnswered ? "Router" : p.final?.from === "provider" ? p.final.attempt.upstream : "—"}</span>
            {facts.replyBytes != null && <Fact label="Size">{fmtBytes(facts.replyBytes)}</Fact>}
            {routerAnswered && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--warn)", marginLeft: "auto" }}>Returned to client</span>}
          </Row>
          <Row label="Status">
            <span style={{ color: p.status.color, fontWeight: 600 }}>{p.status.label}</span>
            {/* A provider's answer names its error on its own try, outlined above; only the router's own needs it here. */}
            {routerAnswered && finalCode && <ErrorChip code={finalCode} entry={entry} />}
            {routerAnswered && entry && <SourceTag source={entry.source} />}
            {p.status.detail && <span style={{ color: "var(--text-3)" }}>{p.status.detail}</span>}
            {p.isWrite && entry?.mayHaveGoneThrough && (
              <span title="The transaction may be on chain despite this error." style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, background: "color-mix(in srgb, var(--info) 14%, transparent)", color: "var(--info)" }}>May already be on chain</span>
            )}
          </Row>
          {p.retries && <Row label="Retries">{p.retries}</Row>}
          {blockAhead && <Row label="Note">Requested block is ahead of the router&apos;s latest block.</Row>}
          {p.extra?.map((x) => <Row key={x.label} label={x.label}>{x.value}</Row>)}
          {entry && <Row label="Next step"><span style={{ color: "var(--text)" }}>{entry.action}</span></Row>}
        </div>
      </Part>
    </div>
  );
}
