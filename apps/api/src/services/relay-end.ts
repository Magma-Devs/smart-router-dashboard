/**
 * smart-router's `relay_end` event (#543 on): one line per relay, written at
 * every log level, with the request's chain, method, outcome and every try.
 * Its contract is smart-router's docs/RELAY-END-EVENT.md, schema 1. A request
 * that has one is read from it alone - its narrative lines are level-bound and
 * a router at `warn` writes none. A router before #543 writes no event, and its
 * requests are read from their lines as before (router-log.ts).
 *
 * The event's prose (`error`, an attempt's `message`) is shown, never matched:
 * a failure is its `outcome` and `error_code`.
 */
import type { CallFacts, RelayAttempt } from "@sr/shared";
import { CANCELLED_NOTE, METHOD_REDACTED, scrubUrls, str, type RouterLine } from "./router-log.js";

/** The line filter that selects the event. */
export const RELAY_END = `"event":"relay_end"`;

/** What the client got when the request failed - the server-errors alert's set. */
export const FAILED_OUTCOMES = ["no_answer", "write_unknown", "rejected_before_dispatch", "router_error"] as const;

/** Every `outcome`, the request's or a try's, that says something went wrong. A try called off (`cancelled`) is not one. */
export const WRONG_OUTCOMES = [...FAILED_OUTCOMES, "node_error", "rate_limited", "timeout", "transport_error"] as const;

/**
 * Keeps the requests the router parsed: `method` and `selection` are both
 * empty only for one it couldn't. `__error__=""` drops a line cut short before
 * those fields, which would otherwise fail a metric query.
 */
export const PARSED_PIPELINE = `| json outcome="outcome", method="method", selection="selection" | __error__="" | method!="" or selection!=""`;

/**
 * The event's failed requests, as a LogQL pipeline: the server-errors alert's
 * leg, so the two count the same requests. The `outcome` line filter only
 * spares the parser lines it would drop anyway: no try takes those values.
 */
export const FAILED_PIPELINE =
  `|= \`${RELAY_END}\` |~ \`"outcome":"(${FAILED_OUTCOMES.join("|")})"\` ${PARSED_PIPELINE}` +
  ` | selection!="subscription" | outcome=~\`${FAILED_OUTCOMES.join("|")}\``;

export const isRelayEnd = (l: RouterLine) => l.f.event === "relay_end";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A request the router parsed: `method` and `selection` are both empty only for one it couldn't. */
export const parsed = (l: RouterLine) => str(l.f.method) !== "" || str(l.f.selection) !== "";

/** A WebSocket subscribe / unsubscribe frame or a gRPC stream's open, served by a subscription manager. */
export const isSubscription = (l: RouterLine) => str(l.f.selection) === "subscription";

/** When the router took the request: the event is written at its end, `latency_ms` after. */
export const startMs = (l: RouterLine) => l.tsMs - (num(l.f.latency_ms) ?? 0);

/**
 * The method as the tabs show it. An unlisted method the client named by URL
 * is withheld by the router (`Default-REDACTED`), as a masked path is by the
 * collector; another unlisted one keeps its name. A REST api is shown as the
 * path it is.
 */
export function methodOf(l: RouterLine): string {
  const m = str(l.f.method);
  if (!m) return "unknown";
  if (m === "Default-REDACTED") return METHOD_REDACTED;
  const named = m.replace(/^Default-/, "");
  return str(l.f.api_interface) === "rest" && !named.startsWith("/") ? `/${named}` : named;
}

/** Every method a request asked for: a batch joins its methods with `&`. */
export const methodsOf = (l: RouterLine) => str(l.f.method).split("&").map((m) => m.replace(/^Default-/, "")).filter(Boolean);

interface EventAttempt {
  upstream?: unknown;
  outcome?: unknown;
  error_code?: unknown;
  node_code?: unknown;
  message?: unknown;
  retryable?: unknown;
  batch?: unknown;
  sent_ms?: unknown;
  latency_ms?: unknown;
  stale_fallback?: unknown;
  returned_to_client?: unknown;
}

interface EventSkip {
  upstream?: unknown;
  lag?: unknown;
  threshold?: unknown;
  batch?: unknown;
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function behindHead(s: EventSkip | undefined): string {
  const lag = num(s?.lag);
  const limit = num(s?.threshold);
  if (lag === null) return "behind the chain head this request needs";
  return `${lag} blocks behind the chain head${limit !== null ? ` (up to ${limit} allowed)` : ""}`;
}

/**
 * The event's tries in the tabs' shape, in dispatch order, with each upstream
 * the consistency check passed over in the batch it was passed over in. Times
 * are from the request's start, as the event's are. A cache hit was never
 * sent: it has no batch and no times, and closes the list. A read its first
 * try answered lists no tries; its one try is the upstream that served it.
 */
export function attemptsOf(l: RouterLine): RelayAttempt[] {
  const servedBy = str(l.f.served_by);
  if (!Array.isArray(l.f.attempts) && !Array.isArray(l.f.skipped) && servedBy && str(l.f.outcome) === "ok") {
    return [{ upstream: servedBy, batch: 0, outcome: "ok", replied: true, code: null, retryable: null, message: null, note: null, atMs: 0, endMs: null }];
  }
  const tries = list<EventAttempt>(l.f.attempts);
  const skips = list<EventSkip>(l.f.skipped);
  const lastBatch = Math.max(-1, ...tries.map((a) => num(a.batch) ?? -1), ...skips.map((s) => num(s.batch) ?? -1));
  const skipOf = (upstream: string) => skips.find((s) => str(s.upstream) === upstream);

  const sent = tries.map((a): RelayAttempt => {
    const upstream = str(a.upstream);
    const code = str(a.error_code);
    const outcome = str(a.outcome);
    const sentMs = num(a.sent_ms);
    const tookMs = num(a.latency_ms);
    let shown: RelayAttempt["outcome"] = "failed";
    if (outcome === "ok") shown = "ok";
    // The router stopped waiting on it - also when the budget ran out mid-cancel.
    else if (outcome === "cancelled" || code === "PROTOCOL_CONTEXT_CANCELED") shown = "cancelled";
    // Still out when the relay ended: no answer, not a failure of its own.
    else if (outcome === "timeout" && !code) shown = "no-result";
    let note: string | null = null;
    if (a.stale_fallback === true) note = `Sent as a fallback, no other upstream available: ${behindHead(skipOf(upstream))}.`;
    else if (shown === "cancelled") note = CANCELLED_NOTE;
    const message = str(a.message);
    const nodeCode = num(a.node_code);
    return {
      upstream,
      batch: num(a.batch) ?? lastBatch + 1,
      outcome: shown,
      replied: a.returned_to_client === true,
      code: code || null,
      retryable: typeof a.retryable === "boolean" ? a.retryable : null,
      message: message ? scrubUrls(message) : null,
      note,
      atMs: Math.round(sentMs ?? 0),
      endMs: sentMs !== null && tookMs !== null ? Math.round(sentMs + tookMs) : null,
      ...(nodeCode !== null && Number.isInteger(nodeCode) ? { nodeCode } : {}),
    };
  });

  const passedOver = skips.map((s): RelayAttempt => {
    const batch = num(s.batch) ?? 0;
    const sameBatch = sent.find((a) => a.batch >= batch && a.outcome !== "skipped");
    return {
      upstream: str(s.upstream),
      batch,
      outcome: "skipped",
      replied: false,
      code: null,
      retryable: null,
      message: null,
      note: `Skipped: ${behindHead(s)}.`,
      atMs: sameBatch?.atMs ?? 0,
      endMs: null,
    };
  });

  // Batch order, a batch's passed-over upstreams before its sends; stable within each.
  return [...passedOver, ...sent].sort((a, b) => a.batch - b.batch || Number(b.outcome === "skipped") - Number(a.outcome === "skipped"));
}

/** A caller's id or project, as the router wrote it: a string, capped as the router caps it. */
const callerText = (v: unknown): string | undefined => {
  const s = str(v).trim();
  return s ? (s.length > 128 ? s.slice(0, 128) : s) : undefined;
};

/** A count the router wrote: a whole number, 0 or more. */
const whole = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : undefined;
};

/**
 * What the event says about the call itself: the caller's project and ids,
 * the request's and the reply's size, the block the request names and the
 * one the router had. Each only when the event carries it - a router writes
 * none of them before it knows them, and none at all before it learned to.
 */
export function callFactsOf(l: RouterLine): CallFacts {
  const facts: CallFacts = {
    customer: callerText(l.f.customer),
    requestId: callerText(l.f.request_id),
    taskId: callerText(l.f.task_id),
    txId: callerText(l.f.tx_id),
    requestBytes: whole(l.f.request_bytes),
    replyBytes: whole(l.f.reply_bytes),
    requestedBlock: whole(l.f.requested_block),
    seenBlock: whole(l.f.seen_block),
  };
  return Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined)) as CallFacts;
}

/** The first try a node answered with an error, as the event wrote it; null when none did. */
export function nodeRefusalOf(l: RouterLine): { code: string; message: string } | null {
  const a = list<EventAttempt>(l.f.attempts).find((x) => x.outcome === "node_error");
  return a ? { code: str(a.error_code), message: str(a.message) } : null;
}

/** More than one batch went out: the router tried again, or hedged. */
export function retried(l: RouterLine): boolean {
  const batches = new Set(list<EventAttempt>(l.f.attempts).map((a) => num(a.batch)).filter((b): b is number => b !== null));
  return batches.size > 1;
}
