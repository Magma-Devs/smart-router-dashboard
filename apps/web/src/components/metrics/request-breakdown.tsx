"use client";

/* An opened row of either request list - the Errors tab's and the
 * Transactions tab's - as one breakdown in three parts:
 *
 *   Outcome    what the client received: status, the error by name and its
 *              source, returned by, the error's meaning and next step from
 *              the table
 *   Tries      one row per try at a provider: result, error, and a bar on
 *              the request's own timeline, so parallel and late tries show
 *   Details    the facts the router wrote about the call, as a key-value list
 *
 * One statement per error: the outcome names the one that reached the client,
 * each try names its own. The router's code, the node's code and the
 * provider's own words sit behind a name on hover, except where the source is
 * undetermined and the provider's words are the only explanation. Orange marks
 * the one try that reached the client. */

import {
  ERROR_SOURCE_LABELS,
  explainRouterError,
  type CallFacts,
  type ErrorSource,
  type RelayAttempt,
  type RouterErrorCode,
} from "@sr/shared";
import { CopyButton } from "@/components/gateway/CopyButton";
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

/** The error by name, in red text. The router's code, the node's code, the meaning and the provider's words on hover. */
function ErrorName({ code, entry, nodeCode, message }: { code: string; entry: RouterErrorCode | null; nodeCode?: number; message?: string | null }) {
  const title = [
    `${code}${nodeCode != null ? ` · node ${nodeCode}` : ""}`,
    entry?.meaning,
    message,
  ].filter(Boolean).join("\n\n");
  return (
    <span title={title} style={{ fontSize: 12, fontWeight: 600, color: "var(--err)", whiteSpace: "nowrap", cursor: "help" }}>
      {errorName(code)}
    </span>
  );
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 8, minWidth: 0, alignContent: "start" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-2)" }}>{title}</span>
        {aside && <span style={{ fontSize: 11, color: "var(--text-4)" }}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const RESULT: Record<RelayAttempt["outcome"], { words: string; color: string }> = {
  ok: { words: "Succeeded", color: "var(--ok)" },
  failed: { words: "Failed", color: "var(--err)" },
  skipped: { words: "Skipped", color: "var(--text-3)" },
  cancelled: { words: "Cancelled", color: "var(--text-3)" },
  "no-result": { words: "No response", color: "var(--text-3)" },
};

/** The provider's words a try prints under its line: only where nothing else explains the error - no code,
 *  or an undetermined source - and only when they say more than the error's name. */
function triesOwnWords(a: RelayAttempt): string | null {
  const code = a.outcome === "failed" ? realCode(a) : null;
  const entry = code ? explainRouterError(code) : null;
  return a.outcome === "failed" && a.message && (!code || entry?.source === "unclear")
    && !(code && a.message.toLowerCase().includes(codeWords(code))) ? a.message : null;
}

const TRY_COLUMNS = "20px minmax(110px, 1.1fr) minmax(150px, 1.4fr) minmax(120px, 2fr) 64px";

/** One try: provider, result and error, and its bar on the request's timeline. */
function TryRow({ a, n, spanMs }: { a: RelayAttempt; n: number; spanMs: number }) {
  const code = a.outcome === "failed" ? realCode(a) : null;
  const entry = code ? explainRouterError(code) : null;
  const r = RESULT[a.outcome];
  const ok = a.outcome === "ok" || (a.outcome === "no-result" && a.replied);
  const words = ok ? "Succeeded" : r.words;
  const color = ok ? "var(--ok)" : r.color;
  const ownWords = triesOwnWords(a);
  const ran = a.endMs != null && a.outcome !== "skipped";
  const left = spanMs > 0 ? Math.min(100, (a.atMs / spanMs) * 100) : 0;
  const width = ran && spanMs > 0 ? Math.max(0.8, ((a.endMs! - a.atMs) / spanMs) * 100) : 0;
  return (
    <div style={{
      display: "grid", gridTemplateColumns: TRY_COLUMNS, columnGap: 12, alignItems: "center",
      padding: "8px 12px", borderTop: "1px solid var(--line)",
      boxShadow: a.replied ? "inset 2px 0 0 var(--warn)" : undefined,
      background: a.replied ? "color-mix(in srgb, var(--warn) 5%, transparent)" : undefined,
    }}>
      <span className="gw-mono gw-tnum" style={{ fontSize: 11, color: "var(--text-4)" }}>{n}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span className="gw-mono" title={a.upstream} style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.upstream}</span>
        {a.replied && <span title="This try's reply went back to the client." style={{ fontSize: 11, fontWeight: 600, color: "var(--warn)", whiteSpace: "nowrap" }}>→ client</span>}
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        {code
          ? <ErrorName code={code} entry={entry} nodeCode={a.nodeCode} message={a.message} />
          : <span style={{ fontSize: 12, color, whiteSpace: "nowrap" }}>{words}</span>}
        {entry && <SourceTag source={entry.source} />}
      </span>
      <span style={{ position: "relative", height: 8, borderRadius: 2, background: "var(--line)" }}>
        {ran
          ? <span style={{ position: "absolute", top: 0, bottom: 0, left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, minWidth: 2, borderRadius: 2, background: color, opacity: ok || a.outcome === "failed" ? 0.85 : 0.5 }} />
          : <span style={{ position: "absolute", top: -2, bottom: -2, left: `${left}%`, width: 2, background: "var(--text-4)" }} />}
      </span>
      <span className="gw-mono gw-tnum" style={{ fontSize: 11.5, color: "var(--text-2)", textAlign: "right" }}>{ran ? fmtTook(a.endMs! - a.atMs) : "—"}</span>
      {(ownWords || a.note) && (
        <div className={ownWords ? "gw-mono" : undefined} title={ownWords ?? undefined}
          style={{ gridColumn: "2 / -1", marginTop: 4, fontSize: 11.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
  chain: string;
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

/** A label and its value, on one line of a two-column list. */
function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span style={{ fontSize: 11.5, color: "var(--text-3)", whiteSpace: "nowrap", paddingTop: 1 }}>{label}</span>
      <div style={{ fontSize: 12, color: "var(--text)", minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>{children}</div>
    </>
  );
}

/** An ID in mono with its copy button. */
function Id({ value }: { value: string }) {
  return (
    <>
      <span className="gw-mono" title={value} style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{value}</span>
      <CopyButton text={value} />
    </>
  );
}

const kvGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", columnGap: 16, rowGap: 8, alignItems: "start" };

export function RequestBreakdown(p: BreakdownProps) {
  const finalCode =
    p.final?.from === "provider" ? (p.final.attempt.outcome === "failed" ? realCode(p.final.attempt) : null) ?? p.final.code ?? null
      : p.final?.from === "router" ? p.final.code
        : null;
  const entry = finalCode ? explainRouterError(finalCode) : null;
  const routerAnswered = p.final?.from === "router";
  const facts = p.facts;
  const providers = new Set(p.attempts.map((a) => a.upstream)).size;
  const blockAhead = finalCode && facts.requestedBlock != null && facts.seenBlock != null && facts.requestedBlock > facts.seenBlock;
  // The provider's words that reached the client, unless its try already prints them.
  const finalTry = p.final?.from === "provider" && p.final.attempt.outcome === "failed" ? p.final.attempt : null;
  const providerWords = finalTry?.message && !triesOwnWords(finalTry) ? finalTry.message : null;
  // The timeline every try's bar sits on: the request's own duration, or the latest try end when that's longer.
  const spanMs = Math.max(p.tookMs ?? 0, ...p.attempts.map((a) => a.endMs ?? a.atMs), 1);
  const returnedBy = routerAnswered ? "Router" : p.final?.from === "provider" ? p.final.attempt.upstream : null;
  return (
    <div style={{ display: "grid", gap: 16, padding: "8px 4px 12px" }}>
      {/* Outcome: what the client received, and what it means. */}
      <div style={{
        borderRadius: 8, border: "1px solid var(--line)", boxShadow: `inset 2px 0 0 ${p.status.color}`,
        background: `color-mix(in srgb, ${p.status.color} 4%, var(--surface))`, padding: "12px 16px", display: "grid", gap: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: p.status.color }}>{p.status.label}</span>
          {/* A provider's answer names its error on its own try, below; only the router's own needs it here. */}
          {routerAnswered && finalCode && <ErrorName code={finalCode} entry={entry} />}
          {routerAnswered && entry && <SourceTag source={entry.source} />}
          {p.status.detail && <span style={{ fontSize: 12, color: "var(--text-3)" }}>{p.status.detail}</span>}
          {p.isWrite && entry?.mayHaveGoneThrough && (
            <span title="The transaction may be on chain despite this error." style={{ fontSize: 11, fontWeight: 600, color: "var(--info)", border: "1px solid color-mix(in srgb, var(--info) 40%, transparent)", borderRadius: 4, padding: "0 6px" }}>May already be on chain</span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "var(--text-3)", whiteSpace: "nowrap" }}>
            Returned by <span className="gw-mono" style={{ color: routerAnswered ? "var(--warn)" : "var(--text)" }}>{returnedBy ?? "—"}</span>
            <span style={{ margin: "0 8px", color: "var(--text-4)" }}>·</span>
            <span className="gw-mono gw-tnum" style={{ color: "var(--text)" }}>{fmtTook(p.tookMs)}</span>
          </span>
        </div>
        {entry && <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.45 }}>{entry.meaning}</div>}
        {providerWords && (
          <div className="gw-mono" title={providerWords} style={{ fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{providerWords}</div>
        )}
        {(entry?.action || p.retries || blockAhead || p.extra?.length) && (
          <div style={{ ...kvGrid, rowGap: 6, marginTop: 2 }}>
            {entry?.action && <KV label="Next step">{entry.action}</KV>}
            {p.retries && <KV label="Retries"><span style={{ color: "var(--text-2)" }}>{p.retries}</span></KV>}
            {blockAhead && <KV label="Note"><span style={{ color: "var(--text-2)" }}>Requested block is ahead of the router&apos;s latest block.</span></KV>}
            {p.extra?.map((x) => <KV key={x.label} label={x.label}>{x.value}</KV>)}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        {/* Tries: one row each, on the request's timeline. */}
        <div style={{ flex: "2 1 560px", minWidth: 0 }}>
          <Section title="Tries" aside={p.attempts.length ? `${p.attempts.length} on ${providers} ${providers === 1 ? "provider" : "providers"}` : "none logged"}>
            {p.attempts.length > 0 && (
              <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", background: "var(--surface)" }}>
                <div style={{ display: "grid", gridTemplateColumns: TRY_COLUMNS, columnGap: 12, padding: "6px 12px", fontSize: 11, color: "var(--text-4)" }}>
                  <span />
                  <span>Provider</span>
                  <span>Result</span>
                  <span style={{ display: "flex", justifyContent: "space-between" }}>
                    <span className="gw-mono gw-tnum">0</span>
                    <span className="gw-mono gw-tnum">{fmtTook(spanMs)}</span>
                  </span>
                  <span style={{ textAlign: "right" }}>Took</span>
                </div>
                {p.attempts.map((a, i) => <TryRow key={i} a={a} n={i + 1} spanMs={spanMs} />)}
              </div>
            )}
          </Section>
        </div>

        {/* Details: the facts the router wrote about the call. */}
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <Section title="Details">
            <div style={kvGrid}>
              <KV label="Request ID"><Id value={p.guid} /><RequestLogsLink id={p.guid} startMs={p.time} tookMs={p.tookMs} /></KV>
              <KV label="Method"><span className="gw-mono">{p.method}</span></KV>
              <KV label="Chain">{p.chain}</KV>
              <KV label="Time"><span className="gw-mono gw-tnum">{fmtWhen(p.time)}</span></KV>
              {facts.customer && <KV label="Customer"><Id value={facts.customer} /></KV>}
              {facts.requestId && <KV label="Caller request ID"><Id value={facts.requestId} /></KV>}
              {facts.taskId && <KV label="Task ID"><Id value={facts.taskId} /></KV>}
              {facts.txId && <KV label="Tx ID"><Id value={facts.txId} /></KV>}
              {facts.requestedBlock != null && <KV label="Requested block"><span className="gw-mono gw-tnum">{fmtComma(facts.requestedBlock)}</span></KV>}
              {facts.seenBlock != null && <KV label="Router's latest block"><span className="gw-mono gw-tnum">{fmtComma(facts.seenBlock)}</span></KV>}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
