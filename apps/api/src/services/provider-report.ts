/**
 * The provider report: the text a customer pastes into a complaint to one
 * provider about one chain. Its fields follow the template customers already
 * send providers: chain, environment, network URL, methods, problem, start and
 * end, affected volume, example requests, the provider's request ID, raw
 * request and response.
 *
 * Counts come from Prometheus over the exact range; the start, end and the
 * example requests come from the router's logs. Anything we don't record says
 * "Not captured" with the reason — it is never left out, and never guessed.
 */
import { buildChainMetaByIndex, type ProviderReport } from "@sr/shared";
import type { ConfigurationService } from "./configuration.js";
import type { ErrorRequestsService } from "./error-requests.js";
import type { ReadRange } from "./read-range.js";
import type { ProvidersService } from "./providers.js";

/** A host label that looks like an API key: long, or a mix of letters and many digits. */
function looksLikeKey(label: string): boolean {
  if (/^[A-Za-z0-9]{20,}$/.test(label)) return true;
  const digits = (label.match(/\d/g) ?? []).length;
  const letters = (label.match(/[A-Za-z]/g) ?? []).length;
  return label.length >= 12 && digits >= 3 && letters >= 3 && /^[A-Za-z0-9-]+$/.test(label);
}

/**
 * Scheme + host, with any host label that looks like a key replaced by ****.
 * `maskNodeUrl` drops the path (where most keys live) but keeps the host, and
 * some providers put the key in a subdomain.
 */
export function maskReportUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname
      .split(".")
      .map((label) => (looksLikeKey(label) ? "****" : label))
      .join(".");
    return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "";
  }
}

const NOT_CAPTURED_ID = "Not captured - the router doesn't record the provider's request ID yet.";
const NOT_CAPTURED_RAW = "Not captured - the router doesn't keep request bodies.";

const utc = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const comma = (n: number): string => Math.round(n).toLocaleString("en-US");
const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%");

export async function buildProviderReport(deps: {
  providers: ProvidersService;
  errorRequests: ErrorRequestsService;
  config: ConfigurationService | null;
}, q: { providerId: string; spec: string; range: ReadRange }): Promise<ProviderReport | null> {
  const { providers, errorRequests, config } = deps;
  const nodes = await providers.nodesOn(q.providerId, q.spec);
  if (nodes.length === 0) return null;
  const identity = providers.configIndex().identity(nodes[0]!);
  const meta = buildChainMetaByIndex(q.spec);

  const endSec = Math.floor(q.range.endMs / 1000);
  const rangeSec = (q.range.endMs - q.range.startMs) / 1000;
  const [counts, ...logReads] = await Promise.all([
    providers.rangeCounts(nodes, q.spec, endSec, rangeSec),
    ...nodes.map((node) => errorRequests.report(q.range, q.spec, undefined, undefined, node)),
  ]);

  // URLs from the mounted config, for these nodes on this chain.
  const urls = new Set<string>();
  for (const router of config?.getRouters() ?? []) {
    if (router.spec !== q.spec) continue;
    for (const node of router.nodes) {
      if (!nodes.includes(node.name)) continue;
      for (const ep of node.endpoints) {
        const masked = maskReportUrl(ep.urlHost);
        if (masked) urls.add(masked);
      }
    }
  }

  // Failed tries at THIS provider only - a request where only another
  // provider failed is never an example here.
  const failedTries = logReads.flatMap((read) =>
    read.rows.flatMap((row) =>
      row.attempts
        .filter((a) => nodes.includes(a.upstream) && a.outcome === "failed")
        .map((a) => ({ time: row.time, method: row.method, code: a.code, message: a.message, guid: row.guid })),
    ),
  );
  failedTries.sort((a, b) => b.time - a.time);
  const logs: ProviderReport["logs"] = logReads.every((r) => r.available)
    ? "ok"
    : logReads.some((r) => r.reason === "unreachable")
      ? "unreachable"
      : "unconfigured";
  const firstFailureMs = failedTries.length ? failedTries.at(-1)!.time : null;
  const lastFailureMs = failedTries.length ? failedTries[0]!.time : null;
  const moreFailures = logReads.some((r) => r.more);
  const codeCounts = new Map<string, number>();
  for (const t of failedTries) if (t.code) codeCounts.set(t.code, (codeCounts.get(t.code) ?? 0) + 1);
  const topCode = [...codeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const examples = failedTries.slice(0, 5);

  const start = firstFailureMs ?? q.range.startMs;
  const end = lastFailureMs ?? q.range.endMs;
  const problem =
    counts.failed > 0
      ? `Between ${hhmm(start)} and ${hhmm(end)} UTC on ${new Date(start).toISOString().slice(0, 10)}, ` +
        `${comma(counts.failed)} of ${comma(counts.tries)} requests to ${identity.name} on ${meta.name} failed ` +
        `(${pct(counts.failed, counts.tries)})${topCode ? `, mostly ${topCode}` : ""}.`
      : `No failed requests to ${identity.name} on ${meta.name} in this range.`;

  const methodsLine = counts.methods.filter((m) => m.failed > 0).slice(0, 5)
    .map((m) => `${m.method} (${comma(m.failed)} failed of ${comma(m.tries)})`).join(", ");
  const timesNote =
    logs !== "ok" ? " (the range - the router's logs couldn't be read for exact times)" : firstFailureMs === null ? " (the range)" : "";

  const lines = [
    `Provider: ${identity.name}`,
    `Chain: ${meta.name} (${q.spec})`,
    `Environment: ${meta.mainnet ? "Mainnet" : "Testnet"}`,
    `Network URL: ${urls.size ? [...urls].join(", ") : "Not in the mounted config"}`,
    `Method(s): ${methodsLine || "None failed"}`,
    `Problem statement: ${problem}`,
    `Incident start: ${utc(start)}${timesNote}${moreFailures && firstFailureMs !== null ? " or earlier" : ""}`,
    `Incident end: ${utc(end)}${timesNote}`,
    `Affected volume: ${comma(counts.failed)} failed requests out of ${comma(counts.tries)} (${pct(counts.failed, counts.tries)})` +
      (counts.rateLimitHits !== null ? `. Rate-limit hold-offs: ${comma(counts.rateLimitHits)}.` : "."),
    "Example requests:",
    ...(examples.length
      ? examples.map(
          (e) =>
            `- ${utc(e.time)} · ${e.method} · ${e.code ?? "no code"}${e.message ? ` · "${e.message.slice(0, 200)}"` : ""} · Smart Router request ID ${e.guid}`,
        )
      : [logs === "ok" ? "- None in the router's logs for this range." : "- The router's logs couldn't be read."]),
    `Provider request ID: ${NOT_CAPTURED_ID}`,
    `Raw request: ${NOT_CAPTURED_RAW}`,
    `Raw response: ${NOT_CAPTURED_RAW}`,
  ];

  return {
    provider: { id: identity.id, name: identity.name },
    spec: q.spec,
    chainName: meta.name,
    environment: meta.mainnet ? "Mainnet" : "Testnet",
    range: { startMs: q.range.startMs, endMs: q.range.endMs },
    urls: [...urls],
    tries: counts.tries,
    failedTries: counts.failed,
    rateLimitHits: counts.rateLimitHits,
    methods: counts.methods,
    firstFailureMs,
    lastFailureMs,
    moreFailures,
    topCode,
    examples,
    logs,
    problem,
    text: lines.join("\n"),
  };
}
