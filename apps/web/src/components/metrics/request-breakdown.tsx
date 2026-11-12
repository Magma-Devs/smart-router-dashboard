"use client";

/* An opened row of either request list - the Errors tab's and the
 * Transactions tab's - in three parts:
 *
 *   Outcome    what the client received: status, the error's meaning and
 *              next step from the table
 *   Flow       what happened, step by step (stepsOf): the request, each send
 *              with every provider it went to and what that provider
 *              answered, then the answer that went back to the client
 *   Details    the facts the router wrote about the call, as a key-value list
 *
 * One statement per error: the outcome names the router's own, each provider
 * line names its own. The router's code, the node's code and the meaning sit
 * behind a name on hover; the provider's own words show under its line.
 * "→ client" marks the one answer that reached the client. */

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
import { codeWords, fmtTook, fmtWhen, isCache, providerInWords, providerName, realCode, RequestLogsLink } from "./request-log";

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

/** What a provider did with its copy, in a word, where no error code names it. */
function responseWords(a: RelayAttempt, isWrite: boolean): { words: string; color: string } {
  if (a.outcome === "ok" || (a.outcome === "no-result" && a.replied)) return { words: isWrite ? "Took the transaction" : "Answered", color: "var(--ok)" };
  if (a.outcome === "failed") return { words: "Failed", color: "var(--err)" };
  if (a.outcome === "skipped") return { words: "Passed over", color: "var(--text-3)" };
  if (a.outcome === "cancelled") return { words: "Cancelled", color: "var(--text-3)" };
  return { words: "No response logged", color: "var(--text-3)" };
}

/** The provider's own words under its line, unless they only repeat the error's name. */
function ownWords(a: RelayAttempt): string | null {
  if (a.outcome !== "failed" || !a.message) return null;
  const code = realCode(a);
  return code && a.message.trim().toLowerCase() === codeWords(code) ? null : a.message;
}

const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The sends, in the order the router made them: the tries of one batch went out together. */
export function stepsOf(attempts: RelayAttempt[]): { title: string; attempts: RelayAttempt[] }[] {
  const order: number[] = [];
  const byBatch = new Map<number, RelayAttempt[]>();
  for (const a of attempts) {
    if (!byBatch.has(a.batch)) { byBatch.set(a.batch, []); order.push(a.batch); }
    byBatch.get(a.batch)!.push(a);
  }
  let sentBefore = false;
  return order.map((b) => {
    const group = byBatch.get(b)!;
    const sent = group.filter((a) => a.outcome !== "skipped").map((a) => providerInWords(a.upstream));
    const title = !sent.length
      ? `Passed over ${andList(group.map((a) => providerInWords(a.upstream)))}`
      : `${sentBefore ? "Then sent to" : "Sent to"} ${andList(sent)}${sent.length > 1 ? " at the same time" : ""}`;
    if (sent.length) sentBefore = true;
    return { title, attempts: group };
  });
}

const PROVIDER_COLUMNS = "minmax(110px, 1fr) minmax(150px, 2fr) 96px";

/** One provider's line in a send: its name, what it answered, how long it took; its own words under it. */
function ProviderLine({ a, isWrite }: { a: RelayAttempt; isWrite: boolean }) {
  const code = a.outcome === "failed" ? realCode(a) : null;
  const entry = code ? explainRouterError(code) : null;
  const r = responseWords(a, isWrite);
  const words = ownWords(a);
  const below = words ?? a.note ?? (a.outcome === "cancelled" ? "Another provider had already answered, or the client stopped waiting." : null);
  const ran = a.endMs != null && a.outcome !== "skipped";
  return (
    <div style={{
      display: "grid", gridTemplateColumns: PROVIDER_COLUMNS, columnGap: 12, alignItems: "center",
      padding: "8px 12px", borderTop: "1px solid var(--line)",
      background: a.replied ? "var(--surface-2)" : undefined,
    }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span className="gw-mono" title={a.upstream} style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{providerName(a.upstream)}</span>
        {a.replied && <span title="This provider's answer went back to the client." style={{ fontSize: 11, fontWeight: 600, color: "var(--warn)", whiteSpace: "nowrap" }}>→ client</span>}
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        {code
          ? <ErrorName code={code} entry={entry} nodeCode={a.nodeCode} message={a.message} />
          : <span style={{ fontSize: 12, color: r.color, whiteSpace: "nowrap" }}>{r.words}</span>}
        {entry && <SourceTag source={entry.source} />}
      </span>
      <span className="gw-mono gw-tnum" style={{ fontSize: 11.5, color: "var(--text-2)", textAlign: "right" }}>{ran ? fmtTook(a.endMs! - a.atMs) : "—"}</span>
      {below && (
        <div className={words ? "gw-mono" : undefined} title={below}
          style={{ gridColumn: "1 / -1", marginTop: 4, fontSize: 11.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {below}
        </div>
      )}
    </div>
  );
}

/** One numbered step of the flow, on a line that joins it to the next. */
function Step({ n, title, last, children }: { n: number; title: React.ReactNode; last?: boolean; children?: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "20px minmax(0, 1fr)", columnGap: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <span className="gw-tnum" style={{ width: 20, height: 20, borderRadius: 999, border: "1px solid var(--line-2, var(--line))", background: "var(--surface)", display: "grid", placeItems: "center", fontSize: 10.5, color: "var(--text-2)", flexShrink: 0 }}>{n}</span>
        {!last && <span aria-hidden style={{ flex: 1, width: 1, background: "var(--line)", marginTop: 4 }} />}
      </div>
      <div style={{ display: "grid", gap: 8, paddingBottom: last ? 0 : 16, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 500, paddingTop: 1, minWidth: 0 }}>{title}</div>
        {children}
      </div>
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

const fmtBytes = (n: number) => (n < 1024 ? `${fmtComma(n)} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const kvGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", columnGap: 16, rowGap: 8, alignItems: "start" };

export function RequestBreakdown(p: BreakdownProps) {
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
  const steps = stepsOf(p.attempts);
  return (
    <div style={{ display: "grid", gap: 16, padding: "8px 4px 12px" }}>
      {/* Outcome: what the client received, and what it means. */}
      <div style={{
        borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface)", padding: "12px 16px", display: "grid", gap: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, color: p.status.color }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: p.status.color }} />
            {p.status.label}
          </span>
          {/* A provider's answer names its error on its own try, below; only the router's own needs it here. */}
          {routerAnswered && finalCode && <ErrorName code={finalCode} entry={entry} />}
          {routerAnswered && entry && <SourceTag source={entry.source} />}
          {p.status.detail && <span style={{ fontSize: 12, color: "var(--text-3)" }}>{p.status.detail}</span>}
          {p.isWrite && entry?.mayHaveGoneThrough && (
            <span title="The transaction may be on chain despite this error." style={{ fontSize: 11, fontWeight: 600, color: "var(--info)", border: "1px solid color-mix(in srgb, var(--info) 40%, transparent)", borderRadius: 4, padding: "0 6px" }}>May already be on chain</span>
          )}
          <span style={{ flex: 1 }} />
          <span className="gw-mono gw-tnum" title="How long the request took, start to answer" style={{ fontSize: 12, color: "var(--text-2)", whiteSpace: "nowrap" }}>{fmtTook(p.tookMs)}</span>
        </div>
        {entry && <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.45 }}>{entry.meaning}</div>}
        {/* The one thing to do gets its own box, apart from the facts below it. */}
        {entry?.action && (
          <div className="gw-next-step">
            <span className="gw-next-step-label">Next step</span>
            <span>{entry.action}</span>
          </div>
        )}
        {Boolean(p.retries || blockAhead || p.extra?.length) && (
          <div style={{ ...kvGrid, rowGap: 6, marginTop: 2 }}>
            {p.retries && <KV label="Retries"><span style={{ color: "var(--text-2)" }}>{p.retries}</span></KV>}
            {blockAhead && <KV label="Note"><span style={{ color: "var(--text-2)" }}>Requested block is ahead of the router&apos;s latest block.</span></KV>}
            {p.extra?.map((x) => <KV key={x.label} label={x.label}>{x.value}</KV>)}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        {/* Flow: the request, each send and what every provider answered, then what went back. */}
        <div style={{ flex: "2 1 560px", minWidth: 0 }}>
          <Section title="What happened" aside={p.attempts.length ? `${providers} ${providers === 1 ? "provider" : "providers"}` : "no provider logged"}>
            <div>
              <Step n={1} title={<>Request from the client: <span className="gw-mono">{p.method}</span>{facts.requestBytes != null && <span className="gw-mono gw-tnum" style={{ color: "var(--text-3)", fontWeight: 400 }}> · {fmtBytes(facts.requestBytes)}</span>}</>} />
              {steps.map((s, i) => (
                <Step key={i} n={i + 2} title={s.title}>
                  <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", background: "var(--surface)" }}>
                    <div style={{ display: "grid", gridTemplateColumns: PROVIDER_COLUMNS, columnGap: 12, padding: "6px 12px", fontSize: 11, color: "var(--text-4)" }}>
                      <span>Provider</span>
                      <span>What it answered</span>
                      <span style={{ textAlign: "right" }}>Response time</span>
                    </div>
                    {s.attempts.map((a, j) => <ProviderLine key={j} a={a} isWrite={p.isWrite} />)}
                  </div>
                </Step>
              ))}
              <Step n={steps.length + 2} last title={<>Answer to the client: <span style={{ color: p.status.color }}>{p.status.label}</span></>}>
                <div style={{ fontSize: 12, color: "var(--text-2)", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
                  {p.final?.from === "provider" ? (isCache(p.final.attempt.upstream)
                    ? <span>The answer came from the cache</span>
                    : <span><span className="gw-mono">{p.final.attempt.upstream}</span>&apos;s answer went back</span>)
                    : routerAnswered ? <span>No provider gave a usable answer, so the router sent its own error, named above</span>
                      : <span>The logs don&apos;t show an answer.</span>}
                  {p.tookMs != null && <span className="gw-mono gw-tnum" style={{ color: "var(--text-3)" }}>· after {fmtTook(p.tookMs)}</span>}
                  {facts.replyBytes != null && <span className="gw-mono gw-tnum" style={{ color: "var(--text-3)" }}>· {fmtBytes(facts.replyBytes)}</span>}
                </div>
              </Step>
            </div>
          </Section>
        </div>

        {/* Details: the facts the router wrote about the call. */}
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <Section title="Details">
            <div style={kvGrid}>
              {/* The request's one ID is Smart Router's. The X-Request-Id, X-Task-Id and X-Tx-Id headers the
                  router also logs aren't shown: behind the gateway the first is the gateway's own ID for every request. */}
              <KV label="Smart Router request ID"><span title="The ID Smart Router gives every request: its GUID in the router's logs, and the Lava-Guid header on the reply" style={{ display: "contents" }}><Id value={p.guid} /></span><RequestLogsLink id={p.guid} startMs={p.time} tookMs={p.tookMs} /></KV>
              <KV label="Chain"><span title={p.chainTitle}>{p.chain}</span></KV>
              <KV label="Time"><span className="gw-mono gw-tnum">{fmtWhen(p.time)}</span></KV>
              {facts.customer && <KV label="Customer"><Id value={facts.customer} /></KV>}
              {facts.requestedBlock != null && <KV label="Requested block"><span className="gw-mono gw-tnum">{block(facts.requestedBlock)}</span></KV>}
              {facts.seenBlock != null && <KV label="Router's latest block"><span className="gw-mono gw-tnum">{block(facts.seenBlock)}</span></KV>}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
