"use client";

/* What the two per-request log tables share - the Errors tab's request list
 * and the Transactions tab. Each row shows every try at every upstream as a
 * chip: ✓ succeeded, ✗ failed (with the reason), ↷ skipped, ⊘ cancelled, … no
 * response logged.
 * Attempts sent together sit side by side (a transaction's broadcast); one
 * batch after another is joined by arrows (a retry). The attempt whose
 * response was returned to the client is marked "→ client". An error the router didn't
 * classify shows the node's own words - there is no "unknown error" here. */

import { Fragment, useState } from "react";
import type { RelayAttempt } from "@sr/shared";
import { errorDocsUrl } from "@/lib/error-docs";
import { fmtComma } from "@/lib/format";

/** The router's error code in plain words: NODE_RATE_LIMITED → "rate limited". */
export function codeWords(code: string): string {
  return code.replace(/^(PROTOCOL|NODE|CHAIN|USER)_/, "").toLowerCase().replace(/_/g, " ");
}

/** A code the router gave that says something. UNKNOWN_ERROR says nothing. */
export function realCode(a: RelayAttempt): string | null {
  return a.code && a.code !== "UNKNOWN_ERROR" ? a.code : null;
}

/** The message without the request it wraps - the chip already names the
 *  upstream: 'http request failed: Post "https://host": context deadline
 *  exceeded' → 'context deadline exceeded'. The full text stays in the details. */
function errorWords(a: RelayAttempt): string {
  return (a.message ?? "error").replace(/^http request failed: [A-Za-z]+ "[^"]*": /, "");
}

const clip = (m: string) => (m.length > 64 ? m.slice(0, 61) + "…" : m);

/** What to call a failed try's error: the code in plain words, or the node's own message. */
export function errorLabel(a: RelayAttempt): string {
  const code = realCode(a);
  return code ? codeWords(code) : clip(errorWords(a));
}

/** The error-type filter's key and label. Without a code, the message with
 *  its numbers blanked, so one error on different blocks groups together. */
export function errorType(a: RelayAttempt): { key: string; label: string } {
  const code = realCode(a);
  if (code) return { key: code, label: codeWords(code) };
  const m = errorWords(a).replace(/\d+/g, "#");
  return { key: "msg:" + m, label: clip(m) };
}

/** The error types in these rows, most common first, each with how many rows have it. */
export function errorTypeOptions(rows: { attempts: RelayAttempt[] }[]): { key: string; label: string; count: number }[] {
  const seen = new Map<string, { label: string; count: number }>();
  for (const r of rows) {
    const types = new Map<string, string>();
    for (const a of r.attempts) {
      if (a.outcome !== "failed") continue;
      const t = errorType(a);
      types.set(t.key, t.label);
    }
    for (const [key, label] of types) seen.set(key, { label, count: (seen.get(key)?.count ?? 0) + 1 });
  }
  return [...seen]
    .map(([key, v]) => ({ key, ...v }))
    .sort((x, y) => y.count - x.count || x.label.localeCompare(y.label));
}

export function hasErrorType(r: { attempts: RelayAttempt[] }, key: string): boolean {
  return r.attempts.some((a) => a.outcome === "failed" && errorType(a).key === key);
}

export function fmtWhen(ms: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("en-US", { hour12: false })
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtTook(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 10_000 ? `${fmtComma(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const MARK: Record<RelayAttempt["outcome"], string> = { ok: "✓", failed: "✗", skipped: "↷", cancelled: "⊘", "no-result": "…" };

/**
 * One attempt, as a chip. The mark says how it went (✗ red: it failed). The
 * attempt whose response was returned to the client says so - "→ client" - and is
 * outlined in the colour of what the app got, the row's result: green for a
 * good answer, orange for a node's error. An outline alone meant nothing to
 * anyone who hadn't read the tooltip, and a red one beside an orange "Node
 * error" read as two different things.
 */
function Step({ a, replyColor }: { a: RelayAttempt; replyColor?: string }) {
  const mark = MARK[a.outcome];
  const markColor = a.outcome === "ok" ? "var(--ok)" : a.outcome === "failed" ? "var(--err)" : "var(--text-4)";
  const appColor = replyColor ?? (a.outcome === "ok" ? "var(--ok)" : a.outcome === "failed" ? "var(--warn)" : "var(--text-3)");
  const note =
    a.outcome === "failed" ? errorLabel(a)
      : a.outcome === "skipped" ? "skipped"
        : a.outcome === "cancelled" ? "cancelled"
          : a.outcome === "no-result" ? (a.replied ? "responded" : "no response")
            : "";
  return (
    <span title={[a.replied ? "Its response was returned to the client." : null, a.note, a.message].filter(Boolean).join("\n\n") || undefined} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 6, background: "var(--bg-2)", border: `1px solid ${a.replied ? appColor : "var(--line)"}`, fontSize: 11.5, lineHeight: 1.4, maxWidth: "100%" }}>
      <span style={{ color: markColor, fontWeight: 700 }}>{mark}</span>
      <span className="gw-mono" style={{ color: a.outcome === "ok" || a.outcome === "failed" ? "var(--text)" : "var(--text-3)", whiteSpace: "nowrap" }}>{a.upstream}</span>
      {note && <span style={{ color: a.outcome === "failed" ? "var(--text-2)" : "var(--text-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {note}</span>}
      {a.replied && (
        <span style={{ color: appColor, fontWeight: 600, fontSize: 10.5, whiteSpace: "nowrap", paddingLeft: 7, marginLeft: 1, borderLeft: "1px solid var(--line-2)" }}>→ client</span>
      )}
    </span>
  );
}

/** How a request's tries ended, when the router stopped short of an answer:
 *  said after the last chip. Null when there's nothing to add. */
export function stopMarker(row: { exhausted: boolean; stopReason: string | null; result: string }): { text: string; title: string } | null {
  if (row.exhausted) return { text: "no upstream available", title: "A retry was needed, but no other upstream was available" };
  if (row.stopReason === "NonRetryableNodeError") return { text: "not retryable", title: "Not retried: another upstream would return the same error" };
  if (row.stopReason === "ProcessingTimeout") return { text: "timed out", title: "The request exceeded the router's processing timeout" };
  return null;
}

/** Every try as a chip: side by side within a batch, arrows between batches. */
export function Flow({ attempts, end = null, replyColor }: {
  attempts: RelayAttempt[];
  end?: { text: string; title: string } | null;
  /** The row's result colour - the attempt whose response was returned is outlined in it. */
  replyColor?: string;
}) {
  const batches: RelayAttempt[][] = [];
  for (const a of attempts) {
    const last = batches[batches.length - 1];
    if (last && last[0]!.batch === a.batch) last.push(a);
    else batches.push([a]);
  }
  const arrow = <span style={{ color: "var(--text-4)", fontSize: 12 }}>→</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {batches.map((b, i) => (
        <Fragment key={i}>
          {i > 0 && arrow}
          {b.map((a, j) => <Step key={j} a={a} replyColor={replyColor} />)}
        </Fragment>
      ))}
      {end && (
        <>
          {arrow}
          <span title={end.title} style={{ fontSize: 11.5, color: "var(--text-4)", fontStyle: "italic" }}>{end.text}</span>
        </>
      )}
    </div>
  );
}

const OUTCOME_WORDS: Record<RelayAttempt["outcome"], string> = {
  ok: "succeeded",
  failed: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
  "no-result": "no response logged",
};

/** A row of the details: a time on the left, anything on the right. */
export function DetailLine({ at, children }: { at?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 10, alignItems: "baseline" }}>
      <span className="gw-mono gw-tnum" style={{ fontSize: 11, color: "var(--text-4)" }}>{at ?? ""}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

export const detailText: React.CSSProperties = { fontSize: 11.5, color: "var(--text-2)", marginTop: 3, lineHeight: 1.55, wordBreak: "break-word" };

/** Every try in full, when a row is opened: when it went out, what came back
 *  and how long that took, the router's reasoning, and the words themselves. */
export function AttemptList({ attempts }: { attempts: RelayAttempt[] }) {
  return (
    <>
      {attempts.map((a, i) => (
        <DetailLine key={i} at={`+${fmtComma(a.atMs)} ms`}>
          <div style={{ fontSize: 12, color: "var(--text-2)" }}>
            <span className="gw-mono" style={{ color: "var(--text)" }}>{a.upstream}</span>
            {" - "}
            {a.outcome === "no-result" && a.replied ? "responded" : OUTCOME_WORDS[a.outcome]}
            {a.endMs != null && a.outcome !== "skipped" && <span style={{ color: "var(--text-3)" }}> after {fmtTook(a.endMs - a.atMs)}</span>}
            {a.replied && <span style={{ color: "var(--text-3)" }}> · response returned to the client</span>}
            {realCode(a) && (
              <> · <a className="gw-mono" href={errorDocsUrl(a.code!)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-3)" }}>{a.code}</a></>
            )}
            {a.outcome === "failed" && a.retryable != null && (
              <span style={{ color: "var(--text-4)" }}> · {a.retryable ? "retryable" : "not retryable"}</span>
            )}
          </div>
          {a.note && <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3, lineHeight: 1.5 }}>{a.note}</div>}
          {a.message && <div className="gw-mono" style={detailText}>{a.message}</div>}
        </DetailLine>
      ))}
    </>
  );
}

/** The words the app got back, when a request ended in an error: the
 *  answering upstream's own message, or the router's. Null otherwise. */
export function appGot(row: { result: string; attempts: RelayAttempt[]; error: string | null }): string | null {
  if (row.result === "failed") return row.error;
  if (row.result !== "error-reply" && row.result !== "rejected") return null;
  const replied = row.attempts.find((a) => a.replied);
  return replied ? replied.message ?? (replied.code ? codeWords(replied.code) : null) : null;
}

/** Under a result: where its response came from - "returned by" / "served by"
 *  on one line, the upstream (or the router) on the next, whole. */
export function ResponseSource({ label, name }: { label: string; name: string }) {
  return (
    <div style={{ fontSize: 10.5, color: "var(--text-4)", marginTop: 5, lineHeight: 1.4, minWidth: 0 }}>
      {label}
      <div className="gw-mono" title={name} style={{ color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
    </div>
  );
}

/** "Returned to client: …" - one line under the chips, the full text on hover and in the details. */
export function AppGot({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div title={text} style={{ marginTop: 6, fontSize: 11, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      Returned to client: <span className="gw-mono" style={{ color: "var(--text-2)" }}>{text}</span>
    </div>
  );
}

/** Which kinds of error a request hit, by the router's own verdict: one it
 *  can retry (or did retry), one it can't. A request can have both. */
export function retryKinds(row: { attempts: RelayAttempt[]; retried: boolean; exhausted: boolean; stopReason: string | null }): { retryable: boolean; notRetryable: boolean } {
  const failed = row.attempts.filter((a) => a.outcome === "failed");
  return {
    retryable: failed.some((a) => a.retryable === true) || row.retried || row.exhausted,
    notRetryable: failed.some((a) => a.retryable === false) || row.stopReason === "NonRetryableNodeError",
  };
}

/** An exact time range, unix ms. */
export interface ExactRange { from: number; to: number }

/** `<input type="datetime-local">` speaks local wall time, minutes only. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const dayWords = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const clockWords = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
/** "Sep 29, 16:10 - 16:20", or "Sep 28, 16:10 - Sep 29, 16:20" across midnight. */
export function rangeWords(r: ExactRange): string {
  const same = dayWords(r.from) === dayWords(r.to);
  return `${dayWords(r.from)}, ${clockWords(r.from)} - ${same ? "" : `${dayWords(r.to)}, `}${clockWords(r.to)}`;
}

/**
 * The list's time range: the page's window by default, or an exact From / To
 * to zoom into an incident. The page's other panels keep the page's window -
 * an exact range needs the router's logs, which only the lists read. A picked
 * range reads as one short line; the From / To fields show only while editing.
 */
export function TimeRangeControl({ range, onChange, windowLabel, windowMs }: {
  range: ExactRange | null;
  onChange: (r: ExactRange | null) => void;
  windowLabel: string;
  windowMs: number;
}) {
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null);
  // The latest a time can be: read once, not on every render.
  const [latest] = useState(() => toLocalInput(Date.now()));
  const input: React.CSSProperties = { ...filterSelectStyle, width: 190, colorScheme: "dark light" };
  const link: React.CSSProperties = { border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600, fontFamily: "inherit" };

  if (!range && !draft) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-3)" }}>
        Last {windowLabel}
        <button style={link} onClick={() => { const now = Date.now(); setDraft({ from: toLocalInput(now - windowMs), to: toLocalInput(now) }); }}>
          Pick exact times
        </button>
      </div>
    );
  }
  if (range && !draft) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-3)" }}>
        <span className="gw-mono" style={{ color: "var(--text)" }}>{rangeWords(range)}</span>
        <button style={link} onClick={() => setDraft({ from: toLocalInput(range.from), to: toLocalInput(range.to) })}>Change</button>
        <button style={link} onClick={() => onChange(null)}>Back to the last {windowLabel}</button>
      </div>
    );
  }
  const shown = draft ?? { from: toLocalInput(range!.from), to: toLocalInput(range!.to) };
  const from = new Date(shown.from).getTime();
  const to = new Date(shown.to).getTime();
  const bad = !(from < to) ? "From must be before To" : to - from > 30 * 86_400_000 ? "At most 30 days" : null;
  const apply = (next: { from: string; to: string }) => {
    setDraft(next);
    const f = new Date(next.from).getTime();
    const t = new Date(next.to).getTime();
    if (f < t && t - f <= 30 * 86_400_000) onChange({ from: f, to: t });
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: "var(--text-3)" }}>
      From <input type="datetime-local" aria-label="From" value={shown.from} max={latest} onChange={(e) => apply({ ...shown, from: e.target.value })} style={input} />
      to <input type="datetime-local" aria-label="To" value={shown.to} max={latest} onChange={(e) => apply({ ...shown, to: e.target.value })} style={input} />
      {bad && <span style={{ color: "var(--err)" }}>{bad}</span>}
      {/* The times already apply as they change; Done folds the fields back to one line. */}
      <button style={link} onClick={() => setDraft(null)}>Done</button>
      <button style={link} onClick={() => { setDraft(null); onChange(null); }}>Back to the last {windowLabel}</button>
    </div>
  );
}

/** "Find a request by ID" - the box both log lists carry. */
export function IdSearch({ onFind }: { onFind: (id: string) => void }) {
  const [draft, setDraft] = useState("");
  const id = draft.trim();
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (id) onFind(id); }} style={{ display: "flex", gap: 6 }}>
      <input aria-label="Request ID" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Find a request by ID"
        className="gw-mono" style={{ ...filterSelectStyle, width: 210, fontSize: 11.5 }} />
      <button type="submit" disabled={!id} style={{ ...filterSelectStyle, cursor: id ? "pointer" : "default", color: id ? "var(--text)" : "var(--text-4)" }}>Find</button>
    </form>
  );
}

/** Where a looked-up request sits, above the list: its ID, its result, a way out. The body is the tab's own. */
export function LookupFrame({ id, tag, onClose, children }: { id: string; tag?: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: "1px solid var(--line)", background: "var(--bg-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>Request <span className="gw-mono">{id}</span></span>
        {tag}
        <span style={{ flex: 1 }} />
        <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 14, padding: 0, fontFamily: "inherit" }}>✕</button>
      </div>
      <div style={{ padding: "0 16px 12px", fontSize: 12 }}>{children}</div>
    </div>
  );
}

/** A look-up that found nothing in the range it read - the month is one click, never the default: it reads every line in it. */
export function NotFound({ rangeWords, wide, onWiden }: { rangeWords: string; wide: boolean; onWiden: () => void }) {
  return (
    <div style={{ color: "var(--text-4)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      No request with this ID in the router&apos;s logs {wide ? "of the last 30 days" : rangeWords}.
      {!wide && (
        <button onClick={onWiden} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
          Search the last 30 days
        </button>
      )}
    </div>
  );
}

export const LOGS_UNREADABLE = "The router's logs can't be read, so a request can't be looked up. Set LOKI_URL on the API.";

export const filterSelectStyle: React.CSSProperties = { height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--surface)", color: "var(--text)", fontSize: 12, fontFamily: "inherit", maxWidth: 320 };

export function Pager({ page, pageCount, total, perPage, noun, onPage, more }: {
  page: number; pageCount: number; total: number; perPage: number; noun: string; onPage: (p: number) => void;
  /** Older rows the list hasn't read yet: a button to read them. */
  more?: { loading: boolean; failed?: boolean; onLoad: () => void } | null;
}) {
  if (pageCount <= 1 && !more) return null;
  const btn = (disabled: boolean): React.CSSProperties => ({ padding: "4px 12px", fontSize: 11.5, fontFamily: "inherit", borderRadius: 7, border: "1px solid var(--line)", background: "var(--bg-2)", color: disabled ? "var(--text-4)" : "var(--text-2)", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 });
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 16px", borderTop: "1px solid var(--line)" }}>
      <span style={{ fontSize: 11.5, color: "var(--text-4)" }}>
        {total > 0 ? `${page * perPage + 1}-${Math.min((page + 1) * perPage, total)} of ${total} ${noun}` : ""}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        {more && (
          <button onClick={more.onLoad} disabled={more.loading} style={{ ...btn(more.loading), marginRight: 6 }}>
            {more.loading ? "Loading…" : more.failed ? "Couldn't load - try again" : "Load older"}
          </button>
        )}
        <button onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0} style={btn(page === 0)}>Prev</button>
        <span style={{ fontSize: 11.5, color: "var(--text-3)", alignSelf: "center", minWidth: 54, textAlign: "center" }}>Page {page + 1} / {pageCount}</span>
        <button onClick={() => onPage(Math.min(pageCount - 1, page + 1))} disabled={page === pageCount - 1} style={btn(page === pageCount - 1)}>Next</button>
      </div>
    </div>
  );
}
