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

/** Customer requests on one router, and how many failed. */
export interface FinalResults {
  total: number;
  failed: number;
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
   * Customer requests per router over the last `rangeSec`, and how many failed
   * — once per request, after every retry. Null when there is no log store.
   *
   * This is the count the metrics cannot give. `smartrouter_requests_failed_total`
   * is recorded per relay ATTEMPT: a request that failed on one provider and
   * was saved on another counts as failed. Measured on a production
   * deployment over 30 minutes, the counter said 652 failed on one chain; this
   * log said 0 of 22,336.
   */
  async finalResults(rangeSec: number, atUnix = Math.floor(Date.now() / 1000)): Promise<Map<string, FinalResults> | null> {
    if (!this.baseUrl) return null;
    const range = `${Math.max(60, Math.round(rangeSec))}s`;
    const lines = `{service_name="router"} ${FINAL_RESULT}`;
    const [total, failed] = await Promise.all([
      this.byPod(`sum by (pod) (count_over_time(${lines} [${range}]))`, atUnix),
      // Distinct request ids, as the alert counts them — a request that
      // logged its result twice is one failed request.
      this.byPod(
        `count by (pod) (sum by (pod, GUID) (count_over_time(${lines} ${FAILED_RESULT} | json GUID="GUID" [${range}])))`,
        atUnix,
      ),
    ]);
    const out = new Map<string, FinalResults>();
    const add = (rows: [string, number][], k: keyof FinalResults) => {
      for (const [pod, v] of rows) {
        const router = routerOfPod(pod);
        const cur = out.get(router) ?? { total: 0, failed: 0 };
        cur[k] += Math.round(v);
        out.set(router, cur);
      }
    };
    add(total, "total");
    add(failed, "failed");
    return out;
  }

  private async byPod(query: string, atUnix: number): Promise<[string, number][]> {
    const url = new URL("loki/api/v1/query", this.baseUrl!.endsWith("/") ? this.baseUrl! : `${this.baseUrl}/`);
    url.searchParams.set("query", query);
    url.searchParams.set("time", String(BigInt(atUnix) * 1_000_000_000n));
    const res = await fetch(url, { signal: AbortSignal.timeout(config.loki.timeoutMs) });
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
