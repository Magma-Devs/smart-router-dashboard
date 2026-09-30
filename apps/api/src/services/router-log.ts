/**
 * Reading the router's own log lines (Loki). The router writes a line for each
 * step of every request, all carrying the request's GUID; the Transactions tab
 * and the Errors tab's request list each rebuild one request per GUID from them. That
 * wording is the router's, not an interface - the tests pin it with lines
 * captured from live routers (smart-router :main and 1.5.3).
 */
import type { RelayAttempt, RouterTopology } from "@sr/shared";
import type { LokiClient, LokiLine } from "./loki-client.js";

export interface RouterLine {
  tsMs: number;
  message: string;
  guid: string;
  f: Record<string, unknown>;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function parseRouterLine({ tsMs, line }: LokiLine): RouterLine | null {
  let f: Record<string, unknown>;
  try {
    f = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null; // panics and banners are not JSON
  }
  const message = str(f.message);
  const guid = str(f.GUID);
  return message && guid ? { tsMs, message, guid, f } : null;
}

export const parseAll = (lines: LokiLine[]): RouterLine[] =>
  lines.map(parseRouterLine).filter((l): l is RouterLine => l !== null);

/** An upstream's name: node-error lines print the provider struct
 *  (`{ProviderAddress:sol-publicnode …}`), the others the bare name. */
export function providerOf(v: unknown): string {
  const s = str(v);
  return /ProviderAddress:([^\s},]+)/.exec(s)?.[1] ?? s.trim();
}

/**
 * The method a request asked for: the JSON-RPC body's `method`, else the REST
 * path, else what an error line names it. The router cuts long bodies short,
 * which breaks the JSON - hence the match as a fallback. Tendermint RPC logs no
 * received line at all.
 */
export function methodOf(received: RouterLine | undefined, others: RouterLine[] = []): string {
  const body = received ? str(received.f.body) : "";
  if (body) {
    try {
      const parsed = JSON.parse(body) as { method?: unknown };
      if (typeof parsed.method === "string") return parsed.method;
    } catch {
      const m = /"method"\s*:\s*"([^"]+)"/.exec(body);
      if (m?.[1]) return m[1];
    }
  }
  const path = received ? str(received.f.path) : "";
  let redacted = path === REDACTED;
  if (path && path !== "/" && !redacted) return path;
  for (const l of others) {
    const named = str(l.f.api) || str(l.f.Request).replace(/^Default-/, "");
    if (named === REDACTED) redacted = true;
    else if (named) return named;
  }
  return redacted ? METHOD_REDACTED : "unknown";
}

/** What a log collector that masks paths leaves of one (the fleet's does). */
const REDACTED = "/REDACTED";
/** The method of a REST request whose path the collector masked. */
export const METHOD_REDACTED = "(path redacted)";

/**
 * Upstream URLs routinely carry API keys in the path, and router errors quote
 * them (`Post "https://…/v2/<key>": timeout`). Everywhere else the dashboard
 * masks a node URL to scheme+host; a message shown word for word gets the
 * same treatment.
 */
export function scrubUrls(message: string): string {
  return message.replace(/\b(https?|wss?|grpcs?):\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`;
    } catch {
      return url.replace(/^([a-z]+:\/\/[^/\s"'<>?#]+).*/i, "$1");
    }
  });
}

/** What a request ID can be: the router's are decimal, a client's may be any
 *  plain token - nothing that could reach into the LogQL around it. */
export const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A request value spliced into a LogQL pattern (a chain's spec) must be a
 *  plain token: LogQL raw strings are backtick-quoted and can't escape one,
 *  so a backtick would end the string and let the rest run as LogQL. */
export const LABEL_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/** A config value (an upstream's name) that can sit in a backtick-quoted
 *  LogQL string; one that can't is left out of the query, not spliced in. */
export const inRawString = (s: string) => !s.includes("`");

/** Every line of one request, by its ID, in a range - for a look-up. Null when Loki didn't answer. */
export async function linesOfRequest(
  loki: LokiClient,
  selector: string,
  guid: string,
  fromMs: number,
  toMs: number,
): Promise<RouterLine[] | null> {
  const found = await loki.queryRange(`${selector} |= \`"GUID":"${guid}"\``, fromMs, toMs, 1000, "forward");
  return found === null ? null : parseAll(found).filter((l) => l.guid === guid);
}

/** Array#findLast, which this repo's compile target doesn't have yet. */
export function lastWhere<T>(items: T[], pred: (x: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i]!;
    if (pred(x)) return x;
  }
  return undefined;
}

/**
 * The lines that say what one try at one upstream did:
 *
 *   Choosing providers                        tries going out: `chosenProviders`,
 *                                             every one of a broadcast at once
 *   received node error reply from provider   it answered with an error:
 *                                             `error_name`, `chain_error_message`,
 *                                             `retryable` (the router's verdict)
 *   Relay received a node error               the same error, `Error` - the only
 *                                             one of the two that 1.5.x routers write
 *   direct RPC relay failed in goroutine      no usable answer: `endpoint`, `error`
 *   could not send relay to provider          the same failure, classified:
 *                                             `error_name`, `retryable`. A
 *                                             PROTOCOL_CONTEXT_CANCELED here is
 *                                             the router calling a try off -
 *                                             not a failure
 *   skipping endpoint due to consistency check  passed over: `lag`, `threshold`
 *   … serving from stale fallback             no one else left: `fallbackProviders`
 *                                             are reopened, lag and all
 *   consistency fallback accepted stale …     so the batch just passed over is
 *                                             sent after all
 */
export const TRY_MSG = {
  choosing: "Choosing providers",
  nodeErrorReply: "received node error reply from provider",
  nodeError: "Relay received a node error",
  directFailed: "direct RPC relay failed in goroutine",
  sendFailed: "could not send relay to provider",
  skipped: "skipping endpoint due to consistency check",
  fallback: "all selectable providers failed consistency validation; serving from stale fallback",
  staleAccepted: "consistency fallback accepted stale endpoint batch",
} as const;

/**
 * The lines that end a request the router could not serve, each carrying
 * `error` and the listener as `endpoint` (`<spec><interface>`): nothing came
 * back (`noAnswer`, which returns before "relay finished"), or nothing usable
 * (`gaveUp`). `writeUnknown`: a write the router can't tell went through.
 */
export const END_MSG = {
  noAnswer: "failed getting responses from RPC endpoints",
  gaveUp: "failed processing responses from RPC endpoints",
  writeUnknown: "write outcome unknown",
} as const;

export const CANCELLED_NOTE = "Cancelled: another attempt had already succeeded, or the client disconnected.";

/** "context canceled": the router stopped waiting on the try, it didn't fail. */
const isCancel = (code: string, message: string) =>
  code === "PROTOCOL_CONTEXT_CANCELED" || /\bcontext canceled\b/i.test(message);

/** The router's `retryable` verdict on an error line; null when the line has none. */
function retryableOf(l: RouterLine): boolean | null {
  const v = str(l.f.retryable);
  return v === "true" ? true : v === "false" ? false : null;
}

/** How far behind a passed-over upstream was, from the skip line's own fields. */
function behindHead(l: RouterLine): string {
  const lag = str(l.f.lag);
  const limit = str(l.f.threshold);
  if (!lag) return "behind the chain head this request needs";
  return `${lag} blocks behind the chain head${limit ? ` (up to ${limit} allowed)` : ""}`;
}

/**
 * Every try of one request, in the order the router made them. `ordered` is
 * the request's lines in time order, `t0` its arrival, `finished` its "relay
 * finished" line: `served_by` there marks the try whose reply went back.
 */
export function triesOf(ordered: RouterLine[], t0: number, finished: RouterLine | undefined): RelayAttempt[] {
  const attempts: RelayAttempt[] = [];
  const ms = (l: RouterLine) => Math.round(l.tsMs - t0);
  // The attempts of the latest "Choosing providers" line - what a stale
  // fallback sends - and, per passed-over try, how far behind it was.
  let batch = -1;
  let batchStart = 0;
  let reopened = new Set<string>();
  const behind = new Map<RelayAttempt, string>();
  const latest = (upstream: string) => lastWhere(attempts, (a) => a.upstream === upstream);
  const open = (upstream: string) => lastWhere(attempts, (a) => a.upstream === upstream && a.outcome === "no-result");
  const fail = (a: RelayAttempt | undefined, l: RouterLine, code: string, message: string) => {
    if (!a) return;
    if (isCancel(code, message)) {
      // Called off, not failed - unless it had failed already.
      if (a.outcome === "failed") return;
      a.outcome = "cancelled";
      a.note = a.note ?? CANCELLED_NOTE;
    } else {
      // A failure proves the try went out, whatever the skip line said.
      if (a.outcome === "skipped") a.note = `Sent as a fallback despite the lag: ${behind.get(a) ?? "behind the chain head"}.`;
      else if (a.outcome === "cancelled") a.note = null;
      a.outcome = "failed";
    }
    a.code = code || a.code;
    a.retryable = a.retryable ?? retryableOf(l);
    a.message = a.message ?? (message ? scrubUrls(message) : null);
    a.endMs = a.endMs ?? ms(l);
  };

  for (const l of ordered) {
    switch (l.message) {
      case TRY_MSG.choosing:
        batch += 1;
        batchStart = attempts.length;
        for (const upstream of str(l.f.chosenProviders).split(",").map((s) => s.trim()).filter(Boolean)) {
          attempts.push({ upstream, batch, outcome: "no-result", replied: false, code: null, retryable: null, message: null, note: null, atMs: ms(l), endMs: null });
        }
        break;
      case TRY_MSG.nodeErrorReply: {
        const p = providerOf(l.f.provider);
        fail(open(p) ?? latest(p), l, str(l.f.error_name), str(l.f.chain_error_message) || str(l.f.error));
        break;
      }
      case TRY_MSG.nodeError: {
        const p = providerOf(l.f.provider);
        fail(open(p) ?? latest(p), l, "", str(l.f.Error));
        break;
      }
      case TRY_MSG.directFailed:
        fail(open(str(l.f.endpoint)), l, "", str(l.f.error));
        break;
      case TRY_MSG.sendFailed: {
        const p = providerOf(l.f.provider);
        fail(open(p) ?? latest(p), l, str(l.f.error_name), str(l.f.error));
        break;
      }
      case TRY_MSG.skipped: {
        const a = open(str(l.f.endpoint));
        if (a) {
          a.outcome = "skipped";
          behind.set(a, behindHead(l));
          a.note = `Skipped: ${behind.get(a)}.`;
        }
        break;
      }
      case TRY_MSG.fallback:
        reopened = new Set(str(l.f.fallbackProviders).split(/[\s,[\]]+/).filter(Boolean));
        break;
      case TRY_MSG.staleAccepted:
        // The skip line was written before the router reopened the batch, so
        // these tries went out after all - lag and all.
        for (const a of attempts.slice(batchStart)) {
          if (a.outcome !== "skipped" || (reopened.size && !reopened.has(a.upstream))) continue;
          a.outcome = "no-result";
          a.note = `Sent as a fallback, no other upstream available: ${behind.get(a) ?? "behind the chain head"}.`;
        }
        break;
    }
  }

  const servedBy = finished ? str(finished.f.served_by) : "";
  const replied = servedBy ? latest(servedBy) : undefined;
  if (replied && finished) {
    replied.replied = true;
    if (replied.outcome === "no-result" || replied.outcome === "cancelled") {
      replied.outcome = "ok";
      replied.note = null;
    }
    replied.endMs = replied.endMs ?? ms(finished);
  }
  return attempts;
}

/** The GUID suffix the router appends to its own errors. */
export function withoutGuid(message: string): string {
  return message.replace(/\s*\{GUID:[^}]*\}/g, "");
}

/** What the values file says about an upstream on one chain. */
export interface UpstreamInfo {
  spec: string;
  interfaces: string[];
}

/**
 * The values file's upstreams, keyed by chain AND name: one node name can
 * serve many chains, so a name alone never says which chain a request was on.
 */
export class UpstreamIndex {
  private readonly bySpecName = new Map<string, UpstreamInfo>();
  private readonly specsByName = new Map<string, Set<string>>();

  constructor(routers: RouterTopology[]) {
    for (const r of routers) {
      for (const n of r.nodes) {
        const key = `${r.spec}\u0000${n.name}`;
        const info = this.bySpecName.get(key) ?? { spec: r.spec, interfaces: [] };
        for (const e of n.endpoints) if (!info.interfaces.includes(e.interface)) info.interfaces.push(e.interface);
        this.bySpecName.set(key, info);
        this.specsByName.set(n.name, (this.specsByName.get(n.name) ?? new Set()).add(r.spec));
      }
    }
  }

  info(spec: string, name: string): UpstreamInfo | null {
    return this.bySpecName.get(`${spec}\u0000${name}`) ?? null;
  }

  /** The chains a request can be on: those serving every configured name it used. */
  chainsOf(names: Iterable<string>): string[] {
    let chains: string[] | null = null;
    for (const name of names) {
      const specs = this.specsByName.get(name);
      if (!specs) continue;
      chains = chains === null ? [...specs] : chains.filter((s) => specs.has(s));
    }
    return (chains ?? []).sort();
  }
}

/** Every upstream name a request's "Choosing providers" lines offered or picked, and its tries'. */
export function namesOf(ordered: RouterLine[], attempts: RelayAttempt[]): string[] {
  const names = new Set(attempts.map((a) => a.upstream));
  for (const l of ordered) {
    if (l.message !== TRY_MSG.choosing) continue;
    for (const field of [l.f.chosenProviders, l.f.validAddresses]) {
      for (const n of str(field).split(",")) if (n.trim()) names.add(n.trim());
    }
  }
  return [...names];
}

/** A listener as the router names it: `<spec><interface>`. */
const LISTENER = /^(.+?)(jsonrpc|rest|tendermintrpc|grpc)$/;
const END_LINES: ReadonlySet<string> = new Set(Object.values(END_MSG));

/** The LogQL pattern of a chain's listener on the lines that end a request (`"endpoint":"ETH1jsonrpc"`). */
export const listenerPattern = (spec: string) => `"endpoint":"${escapeRe(spec)}(jsonrpc|rest|tendermintrpc|grpc)"`;

/**
 * A request's chain: the one its lines name (`chain_id`, or the listener on
 * the line that ends it), else the only chain serving every upstream it used.
 * `specs` lists the candidates when several do.
 */
export function chainOf(ordered: RouterLine[], names: string[], index: UpstreamIndex): { spec: string | null; specs?: string[] } {
  const named = str(ordered.find((l) => str(l.f.chain_id))?.f.chain_id);
  if (named) return { spec: named };
  // With no upstream left to choose, a request's only line is its end.
  const end = ordered.find((l) => END_LINES.has(l.message) && str(l.f.endpoint));
  const listened = end ? LISTENER.exec(str(end.f.endpoint))?.[1] : undefined;
  if (listened) return { spec: listened };
  const chains = index.chainsOf(names);
  if (chains.length === 1) return { spec: chains[0]! };
  return chains.length > 1 ? { spec: null, specs: chains } : { spec: null };
}

/** Whether a row belongs to a chain: its own, or one of its candidates when the logs can't tell. */
export const onChain = (row: { spec: string | null; specs?: string[] }, spec: string) =>
  row.spec === spec || (row.spec === null && (row.specs?.includes(spec) ?? false));

/**
 * Whether a row belongs to a config router: on its chain, and sent to one of
 * its upstreams. A request sent nowhere (no upstream could be chosen) is its
 * router's only when no other router serves that chain.
 */
export function ownRow(
  row: { spec: string | null; specs?: string[]; attempts: { upstream: string }[] },
  router: RouterTopology,
  routers: RouterTopology[],
): boolean {
  if (!onChain(row, router.spec)) return false;
  if (!row.attempts.length) return !routers.some((r) => r.id !== router.id && r.spec === router.spec);
  const own = new Set(router.nodes.map((n) => n.name));
  return row.attempts.some((a) => own.has(a.upstream));
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** GUIDs per follow-up query - they go into one regex alternation. */
const GUID_BATCH = 100;

/**
 * Every line of these requests whose message matches one of `messages`, from
 * `fromMs` to `toMs` (now by default). Null when Loki didn't answer - never a
 * partial list.
 */
export async function linesForGuids(
  loki: LokiClient,
  selector: string,
  guids: string[],
  fromMs: number,
  messages: string[],
  perGuid: number,
  toMs: number = Date.now(),
): Promise<RouterLine[] | null> {
  // IDs read back out of log lines go into the next query: plain tokens only.
  const ids = guids.filter((g) => REQUEST_ID.test(g));
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += GUID_BATCH) batches.push(ids.slice(i, i + GUID_BATCH));
  const pattern = messages.map(escapeRe).join("|");
  const results = await Promise.all(
    batches.map((batch) =>
      loki.queryRange(
        `${selector} |~ \`"GUID":"(${batch.join("|")})"\` |~ \`${pattern}\``,
        fromMs,
        toMs,
        batch.length * perGuid,
        "forward",
      ),
    ),
  );
  if (results.some((r) => r === null)) return null;
  return parseAll(results.flatMap((r) => r ?? []));
}
