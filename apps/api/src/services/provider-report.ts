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
 *
 * A provider lets a request down in two ways, and the report keeps them
 * apart: it doesn't answer usefully (a timeout, a refused connection, a 429 -
 * "failed"), or it answers with an error ("error reply"). The router counts
 * the second as a served request, so a provider that refuses nine calls in
 * ten has an error rate near zero; left out, the report would say "no failed
 * requests" above a list of them. Only an error reply has a provider request
 * ID and a response body: the router logs them off the reply it got.
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
const NO_REPLY_ID = "Not captured - the router records it only when the provider replies, and none of these requests got a reply.";
const NOT_CAPTURED_RAW = "Not captured - the router doesn't keep request bodies.";
const NO_REPLY_RAW = "Not captured - the router keeps a response only when the provider replies with an error.";

const utc = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const comma = (n: number): string => Math.round(n).toLocaleString("en-US");
const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%");

/** The most common code in a list, or null when none carries one. */
function topCodeOf(tries: { code: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const t of tries) if (t.code) counts.set(t.code, (counts.get(t.code) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** How many examples a report lists, and how many of them an error reply is owed when both kinds happened. */
const EXAMPLES = 5;
const REPLY_EXAMPLES_MIN = 2;

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
  // This provider's failures on this chain only: its node name serves other
  // chains too, and a busy one would fill the read before this one is reached.
  const readLogs = async (node: string) => {
    const onChain = await errorRequests.report(q.range, q.spec, undefined, undefined, node, { onChainLines: true });
    // An older router's node-error line doesn't name the chain: read the node's lines whole.
    return onChain.available && onChain.rows.length === 0
      ? errorRequests.report(q.range, q.spec, undefined, undefined, node)
      : onChain;
  };
  const [counts, ...logReads] = await Promise.all([
    providers.rangeCounts(nodes, q.spec, endSec, rangeSec),
    ...nodes.map(readLogs),
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

  // Tries at THIS provider only - a request where only another provider
  // failed is never an example here.
  const seen = new Set<string>();
  const letDown = logReads
    .flatMap((read) =>
      read.rows.flatMap((row) =>
        row.attempts
          .filter((a) => nodes.includes(a.upstream) && a.outcome === "failed")
          .map((a) => ({
            time: row.time,
            method: row.method,
            kind: a.errorReply ? ("error-reply" as const) : ("failed" as const),
            code: a.code,
            message: a.message,
            guid: row.guid,
            providerRequestId: a.errorReply?.requestId ?? null,
            response: a.errorReply?.body ?? null,
          })),
      ),
    )
    // The fallback read can hand a request back twice.
    .filter((t) => !seen.has(`${t.guid}|${t.kind}`) && seen.add(`${t.guid}|${t.kind}`))
    .sort((a, b) => b.time - a.time);
  const failedRead = letDown.filter((t) => t.kind === "failed");
  const repliesRead = letDown.filter((t) => t.kind === "error-reply");

  const logs: ProviderReport["logs"] = logReads.every((r) => r.available)
    ? "ok"
    : logReads.some((r) => r.reason === "unreachable")
      ? "unreachable"
      : "unconfigured";
  const firstFailureMs = letDown.length ? letDown.at(-1)!.time : null;
  const lastFailureMs = letDown.length ? letDown[0]!.time : null;
  const moreFailures = logReads.some((r) => r.more);
  const topCode = topCodeOf(failedRead);
  const topReplyCode = topCodeOf(repliesRead);
  // The newest of each kind, so the rarer one isn't pushed out by the other.
  const replySlots = Math.min(repliesRead.length, Math.max(REPLY_EXAMPLES_MIN, EXAMPLES - failedRead.length));
  const examples = [...failedRead.slice(0, EXAMPLES - replySlots), ...repliesRead.slice(0, replySlots)].sort((a, b) => b.time - a.time);

  // The counts cover the whole range. The logs give exact times only when
  // every failure was read: with more than one read holds, the oldest one
  // read is not the first, so the range's own start stands.
  const start = firstFailureMs !== null && !moreFailures ? firstFailureMs : q.range.startMs;
  const end = lastFailureMs ?? q.range.endMs;
  const replies = counts.errorReplies ?? 0;
  const to = `to ${identity.name} on ${meta.name}`;
  const when = `Between ${hhmm(start)} and ${hhmm(end)} UTC on ${new Date(start).toISOString().slice(0, 10)}`;
  const mostly = (code: string | null) => (code ? `, mostly ${code}` : "");
  const failedPart = `${comma(counts.failed)} of ${comma(counts.tries)} requests ${to} failed (${pct(counts.failed, counts.tries)})${mostly(topCode)}`;
  const problem =
    counts.failed > 0 && replies > 0
      ? `${when}, ${failedPart}. ${comma(replies)} more got an error reply (${pct(replies, counts.tries)})${mostly(topReplyCode)}.`
      : counts.failed > 0
        ? `${when}, ${failedPart}.`
        : replies > 0
          ? `${when}, ${comma(replies)} of ${comma(counts.tries)} requests ${to} got an error reply (${pct(replies, counts.tries)})${mostly(topReplyCode)}.`
          : `No failed requests and no error replies ${to} in this range.`;

  const methodsLine = counts.methods
    .filter((m) => m.failed > 0 || (m.errorReplies ?? 0) > 0)
    .slice(0, 5)
    .map((m) => {
      const parts = [
        ...(m.failed > 0 ? [`${comma(m.failed)} failed`] : []),
        ...((m.errorReplies ?? 0) > 0 ? [`${comma(m.errorReplies!)} error replies`] : []),
      ];
      return `${m.method} (${parts.join(", ")} of ${comma(m.tries)})`;
    })
    .join(", ");
  const timesNote =
    logs !== "ok" ? " (the range - the router's logs couldn't be read for exact times)" : firstFailureMs === null ? " (the range)" : "";
  const startNote = timesNote || (moreFailures ? " (the start of the range - it holds more failures than the report read)" : "");
  const anyReplyId = examples.some((e) => e.providerRequestId);
  const anyResponse = examples.some((e) => e.response);
  const anyReply = examples.some((e) => e.kind === "error-reply");

  const lines = [
    `Provider: ${identity.name}`,
    `Chain: ${meta.name} (${q.spec})`,
    `Environment: ${meta.mainnet ? "Mainnet" : "Testnet"}`,
    `Network URL: ${urls.size ? [...urls].join(", ") : "Not in the mounted config"}`,
    `Method(s): ${methodsLine || "None"}`,
    `Problem statement: ${problem}`,
    `Incident start: ${utc(start)}${startNote}`,
    `Incident end: ${utc(end)}${timesNote}`,
    `Affected volume: ${comma(counts.failed)} failed requests out of ${comma(counts.tries)} (${pct(counts.failed, counts.tries)}).` +
      (counts.errorReplies !== null ? ` Error replies: ${comma(replies)} (${pct(replies, counts.tries)}).` : " Error replies: not counted by this router.") +
      (counts.rateLimitHits !== null ? ` Rate-limit hold-offs: ${comma(counts.rateLimitHits)}.` : ""),
    "Example requests:",
    ...(examples.length
      ? examples.map((e) =>
          [
            `- ${utc(e.time)}`,
            e.method,
            e.kind === "error-reply" ? "error reply" : "failed",
            e.code ?? "no code",
            ...(e.message ? [`"${e.message.slice(0, 200)}"`] : []),
            `Smart Router request ID ${e.guid}`,
            ...(e.providerRequestId ? [`provider request ID ${e.providerRequestId}`] : []),
            ...(e.response ? [`response ${e.response.slice(0, 300)}`] : []),
          ].join(" · "),
        )
      : [logs === "ok" ? "- None in the router's logs for this range." : "- The router's logs couldn't be read."]),
    `Provider request ID: ${anyReplyId ? "With each example above that got a reply." : anyReply || !examples.length ? NOT_CAPTURED_ID : NO_REPLY_ID}`,
    `Raw request: ${NOT_CAPTURED_RAW}`,
    `Raw response: ${anyResponse ? "With each example above that got a reply." : anyReply || !examples.length ? NOT_CAPTURED_RAW : NO_REPLY_RAW}`,
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
    errorReplies: counts.errorReplies,
    rateLimitHits: counts.rateLimitHits,
    methods: counts.methods,
    firstFailureMs,
    lastFailureMs,
    moreFailures,
    topCode,
    topReplyCode,
    examples,
    logs,
    problem,
    text: lines.join("\n"),
  };
}
