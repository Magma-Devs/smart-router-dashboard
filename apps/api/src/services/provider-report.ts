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

const NO_REPLY_ID = "Not captured - the router reads it from the provider's reply, and this try got none.";
const NO_HEADER_ID = "Not captured - the provider's reply had no X-Request-Id header.";
const NO_EXAMPLE = "Not captured - no example request in the router's logs for this range.";
const NO_REQUEST_LINE = "Not captured - the router's log has no request line for this request.";
const NO_BODY = "Not captured - the router doesn't log this request's body.";
const NO_REPLY_RAW = "Not captured - the router keeps a reply body only when the provider answers with an error. This try failed with";

const comma = (n: number): string => Math.round(n).toLocaleString("en-US");
const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%");

/** A time zone the report can print in; anything Intl doesn't know falls back to UTC. */
function zoneOf(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** "2026-10-12 19:47:21" and its offset ("UTC+3") in a time zone, as the customer's outreach template writes times. */
function clock(ms: number, tz: string): { date: string; time: string; offset: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(ms));
  const at = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  // "GMT+3" reads as UTC+3; UTC itself prints as plain "UTC", whichever way Intl spells a zero offset.
  const offset = at("timeZoneName").replace(/^GMT/, "UTC").replace(/^UTC[+-]0(?::00)?$/, "UTC") || "UTC";
  return { date: `${at("year")}-${at("month")}-${at("day")}`, time: `${at("hour")}:${at("minute")}:${at("second")}`, offset };
}
const stamp = (ms: number, tz: string): string => {
  const c = clock(ms, tz);
  return `${c.date} ${c.time} (${c.offset})`;
};

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
}, q: { providerId: string; spec: string; range: ReadRange; tz?: string }): Promise<ProviderReport | null> {
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
    const onChain = await errorRequests.report(q.range, q.spec, undefined, undefined, node, { onChainLines: true, withRequest: true });
    // An older router's node-error line doesn't name the chain: read the node's lines whole.
    return onChain.available && onChain.rows.length === 0
      ? errorRequests.report(q.range, q.spec, undefined, undefined, node, { withRequest: true })
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
            request: row.request ?? null,
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
  const tz = zoneOf(q.tz);
  // The counts cover the whole range. The logs give exact times only when
  // every failure was read: with more than one read holds, the oldest one
  // read is not the first, so the range's own start stands.
  const start = firstFailureMs !== null && !moreFailures ? firstFailureMs : q.range.startMs;
  const end = lastFailureMs ?? q.range.endMs;
  const replies = counts.errorReplies ?? 0;
  const to = `to ${identity.name} on ${meta.name}`;
  const from = clock(start, tz);
  const until = clock(end, tz);
  const when = `Between ${from.time.slice(0, 5)} and ${until.time.slice(0, 5)} (${from.offset}) on ${from.date}`;
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
        ...((m.errorReplies ?? 0) > 0 ? [`${comma(m.errorReplies!)} error repl${m.errorReplies === 1 ? "y" : "ies"}`] : []),
      ];
      return `${m.method} (${parts.join(", ")} of ${comma(m.tries)})`;
    })
    .join(", ");
  const timesNote =
    logs !== "ok" ? " - the range; the router's logs couldn't be read for exact times" : firstFailureMs === null ? " - the range" : "";
  const startNote = timesNote || (moreFailures ? " - the start of the range; it holds more failures than the report read" : "");

  // One example carries the raw request and reply: an error reply with the
  // provider's own request ID if there is one - the most a provider can look up.
  const featured =
    examples.find((e) => e.kind === "error-reply" && e.providerRequestId) ??
    examples.find((e) => e.kind === "error-reply") ??
    examples[0] ??
    null;
  const exampleLine = (e: (typeof examples)[number]) =>
    [
      stamp(e.time, tz),
      e.method,
      e.kind === "error-reply" ? "error reply" : "failed",
      e.code ?? "no code",
      ...(e.message ? [`"${e.message.slice(0, 200)}"`] : []),
      `our request ID ${e.guid}`,
      ...(e.providerRequestId ? [`x-request-id ${e.providerRequestId}`] : []),
    ].join(" · ");
  const xRequestId = !featured
    ? NO_EXAMPLE
    : featured.providerRequestId ?? (featured.kind === "error-reply" ? NO_HEADER_ID : NO_REPLY_ID);
  const rawRequest = !featured
    ? NO_EXAMPLE
    : !featured.request
      ? NO_REQUEST_LINE
      : featured.request.body
        ? `${featured.request.path && featured.request.path !== "/" ? `${featured.request.path} ` : ""}${featured.request.body}${featured.request.cut ? " (cut short in the router's log)" : ""}`
        : featured.request.path ?? NO_BODY;
  const rawResponse = !featured
    ? NO_EXAMPLE
    : featured.response ?? `${NO_REPLY_RAW} "${(featured.message ?? featured.code ?? "no answer").slice(0, 200)}".`;
  const others = examples.filter((e) => e !== featured);

  // The customer's outreach template, field for field: Chain, Environment, Network URL,
  // Method(s), Problem statement, Example, Incident start, Affected volume,
  // x-request-id, Raw request, Raw response. "Incident end" is ours.
  const lines = [
    `Chain: ${meta.name} (${q.spec})`,
    `Environment: ${meta.mainnet ? "Mainnet" : "Testnet"}`,
    `Network URL: ${urls.size ? [...urls].join(", ") : "Not in the mounted config"}`,
    `Method(s): ${methodsLine || "None"}`,
    `Problem statement: ${problem}`,
    featured
      ? `Example: ${exampleLine(featured)}`
      : `Example: ${logs === "ok" ? "None in the router's logs for this range." : "The router's logs couldn't be read."}`,
    ...(others.length ? ["More examples:", ...others.map((e) => `- ${exampleLine(e)}`)] : []),
    `Incident start: ${stamp(start, tz)}${startNote}`,
    `Incident end: ${stamp(end, tz)}${timesNote}`,
    `Affected volume: ${comma(counts.failed)} failed requests out of ${comma(counts.tries)} (${pct(counts.failed, counts.tries)}).` +
      (counts.errorReplies !== null ? ` Error replies: ${comma(replies)} (${pct(replies, counts.tries)}).` : " Error replies: not counted by this router.") +
      (counts.rateLimitHits !== null ? ` Rate-limit hold-offs: ${comma(counts.rateLimitHits)}.` : ""),
    `x-request-id: ${xRequestId}`,
    `Raw request: ${rawRequest}`,
    `Raw response: ${rawResponse}`,
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
    timeZone: tz,
    text: lines.join("\n"),
  };
}
