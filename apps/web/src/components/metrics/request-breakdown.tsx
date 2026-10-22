"use client";

/* An opened row of either request list - the Errors tab's and the
 * Transactions tab's - as one breakdown in three parts:
 *
 *   Request                    what was asked, and the facts the router wrote about it
 *   Tries                      one box per try at a provider, in order
 *   What the customer got      the end, in plain words: what happened, what the
 *                              error means, whose it is, what to do
 *
 * Orange marks the one thing that reached the customer: the try whose reply
 * went back, or - when no provider answered - the router's own error. Each
 * error is named by the router's code, in plain words from @sr/shared's
 * table (explainRouterError), with whose error it is beside it; a code the
 * table doesn't know shows the provider's own words, never a guess. */

import {
  ERROR_SOURCE_LABELS,
  explainRouterError,
  type CallFacts,
  type ErrorSource,
  type RelayAttempt,
  type RouterErrorCode,
} from "@sr/shared";
import { CopyButton } from "@/components/gateway/CopyButton";
import { errorDocsUrl } from "@/lib/error-docs";
import { fmtComma } from "@/lib/format";
import { codeWords, fmtTook, fmtWhen, realCode, RequestLogsLink } from "./request-log";

/** Whose error, in one line each: what the tag means on hover. */
export const SOURCE_HINTS: Record<ErrorSource, string> = {
  request: "The request itself: how it was built or sent. Any provider would answer the same.",
  chain: "The chain's rules or state said no. Every healthy, up-to-date provider would answer the same.",
  provider: "One provider, or the path to it. Another provider may answer differently.",
  router: "The router itself failed, or had no provider to send the request to.",
  unclear: "The code alone doesn't say whose error it is. The provider's message decides.",
};

/** The error's name in plain words, as a sentence: NODE_DATA_NOT_HELD → "Data not held". */
export function errorName(code: string): string {
  const w = codeWords(code);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Whose error it is: the table's one word, said as such - "Unclear" alone beside an error's name reads as a
 *  word about the error. What the word means on hover. */
export function SourceTag({ source }: { source: ErrorSource }) {
  return (
    <span title={SOURCE_HINTS[source]}
      style={{ display: "inline-block", fontSize: 10.5, padding: "1px 7px", borderRadius: 4, border: "1px solid var(--line-2)", color: "var(--text-3)", whiteSpace: "nowrap" }}>
      Whose error: <span style={{ color: "var(--text)", fontWeight: 600 }}>{ERROR_SOURCE_LABELS[source]}</span>
    </span>
  );
}

/** An error, by its name, in red: what it means on hover. */
export function ErrorChip({ code, entry }: { code: string; entry: RouterErrorCode | null }) {
  return (
    <span title={entry ? `${code}: ${entry.meaning}` : code}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: "color-mix(in srgb, var(--err) 12%, transparent)", color: "var(--err)", whiteSpace: "nowrap" }}>
      {errorName(code)}
    </span>
  );
}

/** "May have gone through": a transaction may be on chain despite its error. Blue, so orange keeps one meaning. */
function GoneThroughChip() {
  return (
    <span title="The transaction may be on chain despite this error. Check the chain before sending it again."
      style={{ display: "inline-block", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: "color-mix(in srgb, var(--info) 14%, transparent)", color: "var(--info)", whiteSpace: "nowrap" }}>
      May have gone through
    </span>
  );
}

/** "Returned to the customer", in orange: the one thing that reached them. */
function ReturnedChip() {
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--warn)", whiteSpace: "nowrap" }}>→ Returned to the customer</span>
  );
}

const fmtBytes = (n: number) => (n < 1024 ? `${fmtComma(n)} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A part of the breakdown: its name above, its content in a box. */
function Part({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
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
  padding: "10px 12px",
  display: "grid",
  gap: 6,
  minWidth: 0,
});

/** A label and its value, in a row of facts. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 11.5, color: "var(--text-4)", whiteSpace: "nowrap" }}>
      {label} <span className="gw-mono" style={{ color: "var(--text-2)" }}>{children}</span>
    </span>
  );
}

const OUTCOME: Record<RelayAttempt["outcome"], { mark: string; words: string; color: string }> = {
  ok: { mark: "✓", words: "Answered", color: "var(--ok)" },
  failed: { mark: "✗", words: "Failed", color: "var(--err)" },
  skipped: { mark: "↷", words: "Skipped", color: "var(--text-3)" },
  cancelled: { mark: "⊘", words: "Called off", color: "var(--text-3)" },
  "no-result": { mark: "…", words: "No answer logged", color: "var(--text-3)" },
};

/** One try at one provider: how it went, its error by name and whose it is, the provider's own words. */
function TryBox({ a, n, together }: { a: RelayAttempt; n: number; together: boolean }) {
  const code = a.outcome === "failed" ? realCode(a) : null;
  const entry = code ? explainRouterError(code) : null;
  const o = OUTCOME[a.outcome];
  const took = a.endMs != null && a.outcome !== "skipped" ? ` after ${fmtTook(a.endMs - a.atMs)}` : "";
  const words = a.outcome === "no-result" && a.replied ? "Answered" : o.words;
  return (
    <div style={box(a.replied)}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        <span className="gw-mono gw-tnum" style={{ fontSize: 11, color: "var(--text-4)", minWidth: 14 }}>{n}</span>
        <span className="gw-mono" style={{ fontSize: 12.5, color: "var(--text)" }}>{a.upstream}</span>
        <span style={{ fontSize: 12, color: o.color, whiteSpace: "nowrap" }}>
          <b>{o.mark}</b> {words}<span style={{ color: "var(--text-3)" }}>{took}</span>
        </span>
        {together && <span style={{ fontSize: 11, color: "var(--text-4)" }}>sent with the others at once</span>}
        {code && <ErrorChip code={code} entry={entry} />}
        {entry && <SourceTag source={entry.source} />}
        <span style={{ flex: 1 }} />
        {a.replied && <ReturnedChip />}
      </div>
      {a.message && <div className="gw-mono" style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5, wordBreak: "break-word" }}>{a.message}</div>}
      {a.note && <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.5 }}>{a.note}</div>}
      {(a.code || a.nodeCode != null || (a.outcome === "failed" && a.retryable != null)) && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, color: "var(--text-4)" }}>
          {a.code && <a className="gw-mono" href={errorDocsUrl(a.code)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-4)" }} title="The router's own name for this error">{a.code}</a>}
          {a.nodeCode != null && <span className="gw-mono" title="The node's own JSON-RPC error code">node {a.nodeCode}</span>}
          {a.outcome === "failed" && a.retryable != null && <span>{a.retryable ? "The router can try another provider on this error" : "Another provider would give the same answer"}</span>}
          <span className="gw-mono gw-tnum">sent at +{fmtComma(a.atMs)} ms</span>
        </div>
      )}
    </div>
  );
}

/** What reached the customer: the try whose reply went back, or the router's own answer. */
export type FinalAnswer =
  /** `code`: the reply's own code, where the tab has it and the try doesn't (a transaction's refusal). */
  | { from: "provider"; attempt: RelayAttempt; code?: string | null }
  | { from: "router"; code: string | null; message: string | null }
  | null;

export interface BreakdownProps {
  /** Chain and method, as the row names them. */
  chain: string;
  method: string;
  time: number;
  guid: string;
  tookMs: number | null;
  facts: CallFacts;
  attempts: RelayAttempt[];
  final: FinalAnswer;
  /** The end, in one or two plain sentences. */
  headline: string;
  /** A transaction: an error that may have gone through says so. */
  isWrite: boolean;
  /** Anything the tab adds under the end: a transaction's hash, why a result is unknown. */
  extra?: React.ReactNode;
}

/** "1 try at one provider", "3 tries at 2 providers", "none logged". */
function triesWords(attempts: RelayAttempt[]): string {
  if (!attempts.length) return "none logged";
  const providers = new Set(attempts.map((a) => a.upstream)).size;
  return `${attempts.length} ${attempts.length === 1 ? "try" : "tries"} at ${providers === 1 ? "one provider" : `${providers} providers`}`;
}

export function RequestBreakdown(p: BreakdownProps) {
  // Tries in order, each its own number; tries that went out together (a broadcast) say so.
  const together = (a: RelayAttempt) => p.attempts.filter((x) => x.batch === a.batch).length > 1;
  const finalCode =
    p.final?.from === "provider" ? (p.final.attempt.outcome === "failed" ? realCode(p.final.attempt) : null) ?? p.final.code ?? null
      : p.final?.from === "router" ? p.final.code
        : null;
  const entry = finalCode ? explainRouterError(finalCode) : null;
  const routerAnswered = p.final?.from === "router";
  const facts = p.facts;
  return (
    <div style={{ display: "grid", gap: 14, padding: "6px 4px 10px" }}>
      <Part title="Request">
        <div style={box()}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span className="gw-mono" style={{ fontSize: 12.5, color: "var(--text)" }}>{p.method}</span>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>on {p.chain}</span>
            <span className="gw-mono gw-tnum" style={{ fontSize: 11.5, color: "var(--text-4)" }}>{fmtWhen(p.time)} · took {fmtTook(p.tookMs)}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", columnGap: 18, rowGap: 4, alignItems: "center" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-4)" }}>
              ID <span className="gw-mono" style={{ color: "var(--text-2)" }}>{p.guid}</span> <CopyButton text={p.guid} />
              <RequestLogsLink id={p.guid} startMs={p.time} tookMs={p.tookMs} />
            </span>
            {facts.customer && <Fact label="Customer">{facts.customer}</Fact>}
            {facts.requestId && <Fact label="Caller's request ID">{facts.requestId}</Fact>}
            {facts.taskId && <Fact label="Task ID">{facts.taskId}</Fact>}
            {facts.txId && <Fact label="Tx ID">{facts.txId}</Fact>}
            {facts.requestBytes != null && <Fact label="Request size">{fmtBytes(facts.requestBytes)}</Fact>}
            {facts.requestedBlock != null && <Fact label="Block asked for">{fmtComma(facts.requestedBlock)}</Fact>}
            {facts.seenBlock != null && <Fact label="Router's latest block">{fmtComma(facts.seenBlock)}</Fact>}
          </div>
        </div>
      </Part>

      <Part title="Tries" aside={triesWords(p.attempts)}>
        {p.attempts.length === 0
          ? <div style={{ ...box(), fontSize: 12, color: "var(--text-3)" }}>The logs show no try at a provider.</div>
          : p.attempts.map((a, i) => <TryBox key={i} a={a} n={i + 1} together={together(a)} />)}
      </Part>

      <Part title="What the customer got">
        <div style={box(routerAnswered)}>
          {/* A provider's answer carries its error's name in its own orange box above; only the router's own needs it here. */}
          {(routerAnswered || (p.isWrite && entry?.mayHaveGoneThrough)) && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {routerAnswered && finalCode && <ErrorChip code={finalCode} entry={entry} />}
              {routerAnswered && entry && <SourceTag source={entry.source} />}
              {p.isWrite && entry?.mayHaveGoneThrough && <GoneThroughChip />}
              {routerAnswered && <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>from the router</span>}
              <span style={{ flex: 1 }} />
              {routerAnswered && <ReturnedChip />}
            </div>
          )}
          <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.55 }}>
            {p.headline}
            {/* What the router's own facts say about an error: a block newer than its latest may not exist yet. */}
            {finalCode && facts.requestedBlock != null && facts.seenBlock != null && facts.requestedBlock > facts.seenBlock && (
              <> The request asked for block {fmtComma(facts.requestedBlock)}, newer than the router&apos;s latest block ({fmtComma(facts.seenBlock)}), so it may not exist yet.</>
            )}
          </div>
          {routerAnswered && p.final?.from === "router" && p.final.message && (
            <div className="gw-mono" style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5, wordBreak: "break-word" }}>{p.final.message}</div>
          )}
          {entry && (
            <div style={{ display: "grid", gap: 3, fontSize: 12.5, lineHeight: 1.55 }}>
              <div style={{ color: "var(--text-2)" }}><span style={{ color: "var(--text-4)" }}>What it means: </span>{entry.meaning}</div>
              <div style={{ color: "var(--text-2)" }}><span style={{ color: "var(--text-4)" }}>What to do: </span>{entry.action}</div>
            </div>
          )}
          {p.extra}
          {facts.replyBytes != null && <div><Fact label="Reply size">{fmtBytes(facts.replyBytes)}</Fact></div>}
        </div>
      </Part>
    </div>
  );
}
