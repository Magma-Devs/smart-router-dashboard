/**
 * Loki reader - the "latest errors" drill-in.
 *
 * Prometheus holds counts; the request and error TEXT live only in the
 * router's logs. Where the deployment runs Loki (`LOKI_URL` set), this pulls
 * the most recent error lines for a chain - optionally one provider - and
 * hands back the fields an SRE lines up against their own logs: when, who,
 * which method, which code, and the raw message. Where Loki is absent the
 * endpoint says so; it never guesses.
 */
import { config } from "../config.js";
import { providerName } from "./provider-names.js";

export interface RecentError {
  atUnix: number;
  chain: string | null;
  provider: string | null;
  method: string | null;
  errorName: string | null;
  errorCategory: string | null;
  retryable: boolean | null;
  message: string;
}

/**
 * The same error deduplicated: at relay volume one fault repeats hundreds of
 * times a minute, and a list of identical lines reads as noise. One group =
 * one message shape, with how often and how recently - plus one real example
 * carrying the detail (the slot, the nonce) an SRE searches their own logs by.
 */
export interface ErrorGroup {
  count: number;
  lastAtUnix: number;
  errorName: string | null;
  /** Distinct methods this fault hit, most-seen first. */
  methods: string[];
  /** The dominant method — kept for callers that show one. */
  method: string | null;
  provider: string | null;
  /** One real line, credential-scrubbed. */
  example: string;
}

/** Collapse variable payload parts so repeats of one fault group together.
 *  EVERY digit run is payload ("tx nonce 58" and "tx nonce 188" are one
 *  fault) — a 3-digit floor split one nonce problem into five rows. */
export function normalizeErrorMessage(msg: string): string {
  return msg
    .replace(/0x[0-9a-fA-F]{6,}/g, "0x…")
    .replace(/\d+/g, "N")
    .slice(0, 160);
}

/**
 * Provider error bodies routinely embed the full URL that failed - path and
 * query included, which is where API keys live. Keep scheme+host, drop the
 * rest. The same rule the relay applies to config URLs.
 */
export function scrubSecrets(msg: string): string {
  return msg.replace(/(https?:\/\/[^\s/"']+)[^\s"']*/g, "$1/…");
}

/** Group raw lines into top-N error shapes, biggest first. */
export function groupErrors(lines: RecentError[], top = 5): ErrorGroup[] {
  // Identity is the FAULT: code + message shape. The method is detail — one
  // "Block not found" hitting two methods is one problem, not two rows.
  const byShape = new Map<string, ErrorGroup & { methodCounts: Map<string, number> }>();
  for (const e of lines) {
    const key = `${e.errorName}|${normalizeErrorMessage(e.message)}`;
    let g = byShape.get(key);
    if (!g) {
      g = {
        count: 0, lastAtUnix: e.atUnix, errorName: e.errorName,
        methods: [], method: null, provider: e.provider,
        example: scrubSecrets(e.message), methodCounts: new Map(),
      };
      byShape.set(key, g);
    }
    g.count += 1;
    if (e.atUnix > g.lastAtUnix) g.lastAtUnix = e.atUnix;
    if (e.method) g.methodCounts.set(e.method, (g.methodCounts.get(e.method) ?? 0) + 1);
  }
  return [...byShape.values()]
    .sort((a, b) => b.count - a.count || b.lastAtUnix - a.lastAtUnix)
    .slice(0, top)
    .map(({ methodCounts, ...g }) => {
      const methods = [...methodCounts.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
      return { ...g, methods, method: methods[0] ?? null };
    });
}

interface LokiStream {
  values: [string, string][];
}

/**
 * The router writes one of these per customer request, after every retry and
 * failover has run — the request's final answer.
 */
const FINAL_RESULT = '|= `"message":"ProcessingResult RETURNED"`';
/**
 * A final answer that failed the caller: an error, no result, or no reply.
 * The same line and the same test as the team's customer-failure alert, so
 * the page and the alert count the same thing.
 */
const FAILED_RESULT = '|~ `"error":"[^"]+"|"has_result":"false"|"has_reply":"false"`';

/**
 * The background cycle's log reads wait longer than a page does. They count
 * a whole fleet's requests for a window — ~600k lines in 30 minutes on a
 * production deployment, 3.4s alone — and share the store with everything
 * else in the cycle; at the page's 10s they timed out and every card lost
 * its failure count. Nobody is waiting on these.
 */
const BACKGROUND_TIMEOUT_MS = Math.max(config.loki.timeoutMs, 30_000);

/** A request the chain refused, from a provider's reply in the router's log. */
export interface Rejection {
  id: string;
  pod: string;
  atUnix: number;
  /** The chain's reason: CHAIN_NONCE_TOO_LOW, CHAIN_INSUFFICIENT_FUNDS, … */
  code: string;
}

/** Codes meaning the chain refused the caller's own request — every provider gets the same answer. */
const REFUSED_CODES = "CHAIN_NONCE_TOO_LOW|CHAIN_NONCE_TOO_HIGH|CHAIN_INSUFFICIENT_FUNDS|USER_[A-Z_]+";

/** One customer request that failed: its id, the pod that served it, and when. */
export interface FailedRequest {
  id: string;
  pod: string;
  atUnix: number;
}

function safeJson(line: string): Record<string, unknown> {
  try {
    const j = JSON.parse(line) as unknown;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The method a received request asked for: JSON-RPC `method`, "batch", or the REST path. */
export function methodOfRequest(line: Record<string, unknown>): string {
  const message = typeof line.message === "string" ? line.message : "";
  const path = typeof line.path === "string" ? line.path : "";
  if (message.includes("REST")) return path || "unknown";
  if (typeof line.body === "string") {
    if (line.body.trim().startsWith("[")) return "batch";
    const body = safeJson(line.body);
    if (typeof body.method === "string") return body.method;
    // A large request is logged cut short, and a cut body is not JSON — but
    // the method is near the front, so read it straight from the text.
    const m = /"method"\s*:\s*"([^"]{1,100})"/.exec(line.body);
    if (m?.[1]) return m[1];
  }
  return "unknown";
}

/** One provider the router sent a request to, and how that attempt ended. */
export interface Attempt {
  provider: string;
  role: "primary" | "backup";
  /**
   * In plain words. From the router's own failure line when it logged one:
   * "timed out", "rate-limited", … Otherwise from how the request ended —
   * see `traceFromLines`: "no answer", "answered with an error", "result
   * unknown", or "answered" on a request that worked.
   */
  outcome: string;
  /** Seconds after the request arrived that the router sent it here. */
  startSec: number | null;
  /** Seconds after the request arrived that this attempt failed, when logged. */
  endSec: number | null;
}

/** How one customer request went, rebuilt from its lines in the router's log. */
export interface RequestTrace {
  id: string;
  method: string;
  attempts: Attempt[];
  failed: boolean;
  /** From the request arriving to its final answer. */
  seconds: number;
  /** When it ended — what a caller's own log has next to the error. */
  atUnix: number;
  /**
   * The router's own name for why it failed ("PROTOCOL_CONTEXT_DEADLINE"),
   * from its "failed relay" line: the string a support engineer searches the
   * caller's log for. Null when none was logged.
   */
  error: string | null;
}

/** A failure reason in words a customer reads, from the router's own error name. */
export function outcomeWord(errorName: string, statusCode?: string): string {
  const e = errorName.toUpperCase();
  if (statusCode === "429" || e.includes("RATE_LIMIT")) return "rate-limited";
  if (e.includes("DEADLINE") || e.includes("TIMEOUT")) return "timed out";
  if (e.includes("CONNECTION") || e.includes("RESET") || e.includes("EOF")) return "connection dropped";
  if (e.includes("METHOD_NOT") || e.includes("UNIMPLEMENTED") || e.includes("UNSUPPORTED")) return "method not supported";
  if (/^5\d\d$/.test(statusCode ?? "") || e.includes("SERVER_ERROR") || e.includes("UNAVAILABLE")) return "server error";
  if (e.includes("CONSISTENCY") || e.includes("BLOCK")) return "behind the chain";
  return e ? e.replace(/^(NODE|PROTOCOL|CHAIN|USER)_/, "").toLowerCase().replace(/_/g, " ") : "failed";
}

/**
 * Rebuild one request's path from its log lines: which provider was chosen,
 * which backups the router added and when, how each attempt ended, and the
 * result.
 *
 * Read from the lines that name a provider in a field of its own —
 * "Choosing providers", "Optimizer selected backup provider", and "could not
 * send relay to provider" with its `provider`. Never from the error text:
 * that carries the provider's full URL, key included.
 *
 * Most attempts on a failed request log nothing of their own. The router
 * adds a backup every few seconds WITHOUT cancelling the earlier attempts,
 * then gives up at its deadline, so a provider still working on it when that
 * happens leaves no line. What such an attempt did is read from how the
 * request ended: nothing came back to the caller → "no answer"; a reply came
 * back and this was the only attempt without a line → it sent that reply,
 * an error; anything else → "result unknown". Never "replied" on a guess —
 * it was once, and read as "QuickNode answered, so why did it fail?".
 */
export function traceFromLines(id: string, lines: { atNs: bigint; line: Record<string, unknown> }[]): RequestTrace {
  const sorted = [...lines].sort((a, b) => (a.atNs < b.atNs ? -1 : a.atNs > b.atNs ? 1 : 0));
  const t0 = sorted[0]?.atNs ?? 0n;
  const sec = (ns: bigint) => Math.round(Number(ns - t0) / 1e8) / 10;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // `outcome` null = nothing logged for it yet.
  const attempts: (Omit<Attempt, "outcome"> & { outcome: string | null })[] = [];
  const start = (provider: string, role: Attempt["role"], atNs: bigint) => {
    const last = attempts[attempts.length - 1];
    // The router re-validates in a loop and logs the same choice again; only
    // a change of provider, or a new try after the last one ended, is a step.
    if (last && last.provider === provider && last.outcome === null) return;
    attempts.push({ provider, role, outcome: null, startSec: sec(atNs), endSec: null });
  };
  let method = "unknown";
  let failed = false;
  let reply: boolean | null = null;
  let end = t0;
  let error: string | null = null;
  for (const { atNs, line } of sorted) {
    const message = str(line.message);
    if (message.startsWith("failed relay") && !error && /^[A-Z][A-Z0-9_]+$/.test(str(line.error_name))) error = str(line.error_name);
    if (message.startsWith("Consumer received a new")) method = methodOfRequest(line);
    else if (message === "Choosing providers") {
      for (const p of str(line.chosenProviders).split(/[\s,]+/).filter(Boolean)) start(p, "primary", atNs);
    } else if (message.includes("Optimizer selected backup provider")) {
      const p = str(line.selected);
      if (p) start(p, "backup", atNs);
    } else if (message === "could not send relay to provider") {
      const p = str(line.provider);
      if (!p) continue;
      let a = [...attempts].reverse().find((x) => x.provider === p && x.outcome === null);
      if (!a) {
        a = { provider: p, role: "primary", outcome: null, startSec: null, endSec: null };
        attempts.push(a);
      }
      a.outcome = outcomeWord(str(line.error_name), str(line.statusCode));
      a.endSec = sec(atNs);
    } else if (message === "ProcessingResult RETURNED") {
      failed = str(line.error) !== "" || line.has_reply === "false" || line.has_result === "false";
      reply = line.has_reply === "false" ? false : line.has_reply === "true" ? true : null;
      end = atNs;
    }
  }
  const silent = attempts.filter((a) => a.outcome === null).length;
  const settled = !failed
    ? "answered"
    : reply === false
      ? "no answer"
      : reply === true && silent === 1
        ? "answered with an error"
        : "result unknown";
  return {
    id,
    method,
    attempts: attempts.map((a) => ({ ...a, outcome: a.outcome ?? settled })),
    failed,
    seconds: sec(end),
    atUnix: Number(end / 1_000_000_000n),
    error,
  };
}

/**
 * The path as one line:
 *
 *   alchemy ✕ timed out → +7s quicknode (backup) ✕ timed out → failed
 *   tatum ✕ timed out → +8s 3 backups (blockdaemon, lava, quicknode) ✕ none worked → failed
 *
 * "+7s" is when the router sent the request there, counted from its arrival.
 * The router adds a backup without cancelling the earlier attempts, so the
 * steps overlap; without the times an arrow reads as "failed, then the next".
 *
 * Several providers of one kind are one step. Which backup the router picks
 * first changes from request to request, so the exact order split one story
 * — "tatum timed out, all three backups were tried, none worked" — into
 * seventeen lines on one card. The names are sorted, so requests that went
 * that way share the line.
 *
 * `times: false` drops the times: what requests are grouped by.
 */
export function flowOf(t: RequestTrace, { times = true }: { times?: boolean } = {}): string {
  const at = (sec: number | null) => (times && sec != null ? `+${Math.round(sec)}s ` : "");
  const how = (o: string) => (o === "answered" ? "✓ answered" : o === "result unknown" ? "? result unknown" : `✕ ${o}`);
  const steps: string[] = [];
  for (const role of ["primary", "backup"] as const) {
    const tried = t.attempts.filter((a) => a.role === role);
    const first = tried[0];
    if (!first) continue;
    // The first step is the request arriving; every later one says when.
    const when = steps.length > 0 ? at(first.startSec) : "";
    if (tried.length === 1) {
      steps.push(`${when}${providerName(first.provider)}${role === "backup" ? " (backup)" : ""} ${how(first.outcome)}`);
      continue;
    }
    const names = [...new Set(tried.map((a) => providerName(a.provider)))].sort((a, b) => a.localeCompare(b));
    const worked = tried.find((a) => a.outcome === "answered");
    steps.push(
      `${when}${names.length} ${role === "backup" ? "backups" : "providers"} (${names.join(", ")}) ${worked ? `✓ ${providerName(worked.provider)} answered` : "✕ none worked"}`,
    );
  }
  return [...steps, t.failed ? "failed" : "answered"].join(" → ");
}

/** `arbitrum-mainnet-router-6fdddbb79c-fj4kh` → `arbitrum-mainnet`, the router's id. */
export function routerOfPod(pod: string): string {
  return pod.replace(/-router-[a-z0-9]+-[a-z0-9]+$/, "");
}

/** `{ProviderAddress:tatum ProviderReputationSummary:0 …}` → `tatum` */
const PROVIDER_RE = /ProviderAddress:([^\s}]+)/;

export class LokiService {
  constructor(private readonly baseUrl: string | undefined = config.loki.url) {}

  get available(): boolean {
    return Boolean(this.baseUrl);
  }

  /**
   * The routers whose logs reach this store in the window — from the label
   * index, no line read. A router with no logs here has no verdict: "0
   * failed" is only true where the lines exist.
   */
  async routersWithLogs(rangeSec: number, atUnix = Math.floor(Date.now() / 1000)): Promise<Set<string> | null> {
    if (!this.baseUrl) return null;
    const url = new URL("loki/api/v1/series", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    url.searchParams.set("match[]", '{service_name="router"}');
    url.searchParams.set("start", String(BigInt(atUnix - Math.round(rangeSec)) * 1_000_000_000n));
    url.searchParams.set("end", String(BigInt(atUnix) * 1_000_000_000n));
    const res = await fetch(url, { signal: AbortSignal.timeout(BACKGROUND_TIMEOUT_MS) });
    if (!res.ok) throw Object.assign(new Error(`loki ${res.status}`), { statusCode: 503 });
    const body = (await res.json()) as { data?: Record<string, string>[] };
    return new Set((body.data ?? []).map((l) => routerOfPod(l.pod ?? "")).filter(Boolean));
  }

  /**
   * Failed customer requests per router, counted rather than read — only for
   * routers whose failed lines overflowed the read below, which is a bad hour
   * on that router, scoped to its own pods so the scan stays small.
   */
  async countFailed(routers: string[], rangeSec: number, atUnix = Math.floor(Date.now() / 1000)): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.baseUrl || routers.length === 0) return out;
    const pods = routers.map((r) => r.replace(/[^a-z0-9-]/g, "")).join("|");
    const rows = await this.byPod(
      `sum by (pod) (count_over_time({service_name="router", pod=~"(${pods})-router-.*"} ${FINAL_RESULT} ${FAILED_RESULT} [${Math.max(60, Math.round(rangeSec))}s]))`,
      atUnix,
    );
    for (const [pod, v] of rows) {
      const router = routerOfPod(pod);
      out.set(router, (out.get(router) ?? 0) + Math.round(v));
    }
    return out;
  }

  /**
   * Customer requests that failed in the last `rangeSec`, by router: their ids,
   * the pod that served them and when. One read of the final-result lines,
   * filtered to failures — failures are rare (a handful an hour across a
   * fleet on a normal day), so the read is small; `capped` says a bad hour
   * overflowed it, and then the ids are a sample and `countFailed` counts.
   */
  async failedRequests(
    rangeSec: number,
    limit = 5000,
    atUnix = Math.floor(Date.now() / 1000),
  ): Promise<{ byRouter: Map<string, FailedRequest[]>; capped: boolean }> {
    const byRouter = new Map<string, FailedRequest[]>();
    if (!this.baseUrl) return { byRouter, capped: false };
    const streams = await this.range(
      `{service_name="router"} ${FINAL_RESULT} ${FAILED_RESULT}`,
      atUnix - Math.round(rangeSec),
      atUnix,
      limit,
    );
    let lines = 0;
    for (const { labels, lines: ls, times } of streams) {
      const pod = labels.pod ?? "";
      const router = routerOfPod(pod);
      ls.forEach((line, i) => {
        lines++;
        const id = (safeJson(line).GUID as string | undefined) ?? "";
        if (!/^[0-9]+$/.test(id)) return;
        const list = byRouter.get(router) ?? [];
        if (!list.some((f) => f.id === id)) list.push({ id, pod, atUnix: Number(BigInt(times[i] ?? "0") / 1_000_000_000n) });
        byRouter.set(router, list);
      });
    }
    return { byRouter, capped: lines >= limit };
  }

  /**
   * Requests the chain refused, one per request.
   *
   * The log has one line per provider REPLY, and a transaction goes to every
   * primary at once — measured in production, both primaries answered "nonce
   * too low" within 30ms, so each refusal was logged twice and a count of
   * lines doubled it: 308 lines, 154 requests. Deduplicated here by request id.
   */
  async rejectedRequests(
    rangeSec: number,
    limit = 5000,
    atUnix = Math.floor(Date.now() / 1000),
  ): Promise<{ byRouter: Map<string, Rejection[]>; capped: boolean }> {
    const byRouter = new Map<string, Rejection[]>();
    if (!this.baseUrl) return { byRouter, capped: false };
    const streams = await this.range(
      `{service_name="router"} |= "received node error reply from provider" |~ \`"error_name":"(${REFUSED_CODES})"\``,
      atUnix - Math.round(rangeSec),
      atUnix,
      limit,
    );
    let lines = 0;
    for (const { labels, lines: ls, times } of streams) {
      const pod = labels.pod ?? "";
      const router = routerOfPod(pod);
      ls.forEach((raw, i) => {
        lines++;
        const line = safeJson(raw);
        const id = typeof line.GUID === "string" ? line.GUID : "";
        const code = typeof line.error_name === "string" ? line.error_name : "";
        if (!/^[0-9]+$/.test(id) || !code) return;
        const list = byRouter.get(router) ?? [];
        if (!list.some((r) => r.id === id)) list.push({ id, pod, atUnix: Number(BigInt(times[i] ?? "0") / 1_000_000_000n), code });
        byRouter.set(router, list);
      });
    }
    return { byRouter, capped: lines >= limit };
  }

  /**
   * Of these refused transactions, how many had been sent before: the SAME
   * signed transaction, earlier, as a request of its own.
   *
   * Measured in production: every refused transaction checked had been sent 6
   * to 11 times in the half hour before. "The chain refused it" was the app
   * sending a transaction again after it had gone through — not a broken nonce,
   * and not something to blame on the caller's signing code.
   *
   * Only a request whose first parameter is a signed transaction is checked,
   * and only on the part the log keeps: the router cuts a request body at 215
   * characters, which leaves the transaction's first 31 bytes — its chain,
   * nonce, fees, gas limit and the start of its recipient. Another send with
   * all of those the same is, in practice, the same transaction.
   *
   * The transaction goes out in the query, to the operator's own log store;
   * it is never logged, kept or returned — only the counts are.
   */
  async resentTransactions(
    refused: Rejection[],
    perPod = 3,
  ): Promise<{ checked: number; resent: number; mostSends: number }> {
    const out = { checked: 0, resent: 0, mostSends: 0 };
    if (!this.baseUrl) return out;
    const byPod = new Map<string, Rejection[]>();
    for (const r of refused) {
      if (!/^[0-9]+$/.test(r.id) || !/^[a-z0-9-]+$/.test(r.pod)) continue;
      byPod.set(r.pod, [...(byPod.get(r.pod) ?? []), r]);
    }
    for (const [pod, list] of byPod) {
      for (const r of [...list].sort((a, b) => b.atUnix - a.atUnix).slice(0, perPod)) {
        const [received] = await this.range(
          `{service_name="router", pod="${pod}"} |= "${r.id}" |= "Consumer received"`,
          r.atUnix - 60,
          r.atUnix + 2,
          5,
        );
        const body = safeJson(received?.lines[0] ?? "").body;
        const tx = typeof body === "string" ? /"params"\s*:\s*\[\s*"(0x[0-9a-fA-F]{60,})/.exec(body)?.[1] : undefined;
        if (!tx) continue;
        out.checked++;
        const before = await this.range(
          `{service_name="router", pod="${pod}"} |= "Consumer received" |= "${tx.slice(0, 120)}"`,
          r.atUnix - 1800,
          r.atUnix - 1,
          100,
        );
        const sends = before.reduce((n, s) => n + s.lines.filter((l) => safeJson(l).GUID !== r.id).length, 0);
        if (sends > 0) out.resent++;
        out.mostSends = Math.max(out.mostSends, sends);
      }
    }
    return out;
  }

  /**
   * What each request asked for, from the line the router writes when it
   * receives it: the JSON-RPC `method`, a batch as "batch", or the REST path.
   * Only the method is kept — the body carries the caller's parameters and the
   * headers can carry credentials, and neither leaves this function.
   */
  async methodsOf(failures: FailedRequest[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.baseUrl || failures.length === 0) return out;
    // One pod, and only the minutes around its failures: the received line is
    // written seconds before the result, and scanning a whole fleet's window
    // for a few ids is what the store's gateway refused with a 504.
    const byPod = new Map<string, FailedRequest[]>();
    for (const f of failures) {
      if (!/^[0-9]+$/.test(f.id) || !/^[a-z0-9-]+$/.test(f.pod)) continue;
      const list = byPod.get(f.pod) ?? [];
      list.push(f);
      byPod.set(f.pod, list);
    }
    for (const [pod, list] of byPod) {
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const ids = chunk.map((f) => f.id);
        const from = Math.min(...chunk.map((f) => f.atUnix)) - 120;
        const to = Math.max(...chunk.map((f) => f.atUnix)) + 5;
        const streams = await this.range(
          `{service_name="router", pod="${pod}"} |= "Consumer received a new" |~ "${ids.join("|")}"`,
          from,
          to,
          chunk.length * 2,
        );
        for (const { lines } of streams) {
          for (const line of lines) {
            const j = safeJson(line);
            const id = typeof j.GUID === "string" ? j.GUID : "";
            if (!ids.includes(id) || out.has(id)) continue;
            out.set(id, methodOfRequest(j));
          }
        }
      }
    }
    return out;
  }

  /**
   * Trace failed requests: every line each one wrote, on its own pod, in the
   * minute before its final answer. Failures are rare, so this is a handful
   * of lines — but a bad hour is not, so at most `perPod` are traced per pod,
   * newest first, and the caller says it is a sample.
   */
  async traceRequests(failures: FailedRequest[], perPod = 20): Promise<Map<string, RequestTrace>> {
    const out = new Map<string, RequestTrace>();
    if (!this.baseUrl) return out;
    const byPod = new Map<string, FailedRequest[]>();
    for (const f of failures) {
      if (!/^[0-9]+$/.test(f.id) || !/^[a-z0-9-]+$/.test(f.pod)) continue;
      byPod.set(f.pod, [...(byPod.get(f.pod) ?? []), f]);
    }
    for (const [pod, list] of byPod) {
      const chunk = [...list].sort((a, b) => b.atUnix - a.atUnix).slice(0, perPod);
      const ids = chunk.map((f) => f.id);
      const streams = await this.range(
        `{service_name="router", pod="${pod}"} |~ "${ids.join("|")}"`,
        Math.min(...chunk.map((f) => f.atUnix)) - 60,
        Math.max(...chunk.map((f) => f.atUnix)) + 2,
        5000,
      );
      const linesById = new Map<string, { atNs: bigint; line: Record<string, unknown> }[]>();
      for (const { lines, times } of streams) {
        lines.forEach((raw, i) => {
          const line = safeJson(raw);
          const id = typeof line.GUID === "string" ? line.GUID : "";
          if (!ids.includes(id)) return;
          linesById.set(id, [...(linesById.get(id) ?? []), { atNs: BigInt(times[i] ?? "0"), line }]);
        });
      }
      for (const [id, lines] of linesById) out.set(id, traceFromLines(id, lines));
    }
    return out;
  }

  private async range(
    query: string,
    startUnix: number,
    endUnix: number,
    limit: number,
  ): Promise<{ labels: Record<string, string>; lines: string[]; times: string[] }[]> {
    const url = new URL("loki/api/v1/query_range", this.baseUrl!.endsWith("/") ? this.baseUrl! : `${this.baseUrl}/`);
    url.searchParams.set("query", query);
    url.searchParams.set("start", String(BigInt(Math.floor(startUnix)) * 1_000_000_000n));
    url.searchParams.set("end", String(BigInt(Math.floor(endUnix)) * 1_000_000_000n));
    url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 5000)));
    url.searchParams.set("direction", "backward");
    const res = await fetch(url, { signal: AbortSignal.timeout(BACKGROUND_TIMEOUT_MS) });
    if (!res.ok) throw Object.assign(new Error(`loki ${res.status}`), { statusCode: 503 });
    const body = (await res.json()) as { data?: { result?: { stream?: Record<string, string>; values: [string, string][] }[] } };
    return (body.data?.result ?? []).map((r) => ({
      labels: r.stream ?? {},
      lines: r.values.map(([, l]) => l),
      times: r.values.map(([t]) => t),
    }));
  }

  private async byPod(query: string, atUnix: number): Promise<[string, number][]> {
    const url = new URL("loki/api/v1/query", this.baseUrl!.endsWith("/") ? this.baseUrl! : `${this.baseUrl}/`);
    url.searchParams.set("query", query);
    url.searchParams.set("time", String(BigInt(atUnix) * 1_000_000_000n));
    const res = await fetch(url, { signal: AbortSignal.timeout(BACKGROUND_TIMEOUT_MS) });
    if (!res.ok) throw Object.assign(new Error(`loki ${res.status}`), { statusCode: 503 });
    const body = (await res.json()) as { data?: { result?: { metric: Record<string, string>; value: [number, string] }[] } };
    return (body.data?.result ?? []).map((r) => [r.metric.pod ?? "", Number(r.value[1]) || 0]);
  }

  /** Latest error lines, newest first. `spec`/`provider` narrow by line
   *  content - the JSON fields are authoritative, stream labels are not. */
  async recentErrors(spec?: string, provider?: string, limit = 200, startUnix?: number, endUnix?: number, errorName?: string): Promise<RecentError[]> {
    if (!this.baseUrl) return [];
    const filters = [
      `{level="error", service_name="router"}`,
      spec ? `|= \`"chain_id":"${spec.replace(/[^A-Za-z0-9_-]/g, "")}"\`` : "",
      provider ? `|= \`ProviderAddress:${provider.replace(/[^A-Za-z0-9._-]/g, "")}\`` : "",
      // A single-code finding shows its own error only - the chain-wide mix
      // under it reads as aggregation for no reason.
      errorName ? `|= \`"error_name":"${errorName.replace(/[^A-Z0-9_]/g, "")}"\`` : "",
    ].filter(Boolean);
    const nowNs = (endUnix ? BigInt(endUnix) * 1_000n : BigInt(Date.now())) * 1_000_000n;
    const startNs = startUnix ? BigInt(startUnix) * 1_000_000_000n : nowNs - BigInt(24 * 3600) * 1_000_000_000n;
    const url = new URL("loki/api/v1/query_range", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    url.searchParams.set("query", filters.join(" "));
    url.searchParams.set("start", String(startNs));
    url.searchParams.set("end", String(nowNs));
    url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 500)));
    url.searchParams.set("direction", "backward");

    const res = await fetch(url, { signal: AbortSignal.timeout(config.loki.timeoutMs) });
    if (!res.ok) throw Object.assign(new Error(`loki ${res.status}`), { statusCode: 503 });
    const body = (await res.json()) as { data?: { result?: LokiStream[] } };

    const out: RecentError[] = [];
    for (const stream of body.data?.result ?? []) {
      for (const [ns, line] of stream.values) {
        let j: Record<string, string> = {};
        try {
          j = JSON.parse(line) as Record<string, string>;
        } catch {
          // A non-JSON line still carries its text.
        }
        out.push({
          atUnix: Math.floor(Number(ns) / 1e9),
          chain: j.chain_id ?? null,
          provider: PROVIDER_RE.exec(j.provider ?? "")?.[1] ?? null,
          method: j.api ?? null,
          errorName: j.error_name ?? null,
          errorCategory: j.error_category ?? null,
          retryable: j.retryable == null ? null : j.retryable === "true",
          message: j.chain_error_message || j.error || line.slice(0, 300),
        });
      }
    }
    return out.sort((a, b) => b.atUnix - a.atUnix).slice(0, limit);
  }
}
