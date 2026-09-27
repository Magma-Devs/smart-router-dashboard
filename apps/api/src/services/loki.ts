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
    const body = safeJson(line.body);
    if (typeof body.method === "string") return body.method;
    if (line.body.trim().startsWith("[")) return "batch";
  }
  return "unknown";
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
