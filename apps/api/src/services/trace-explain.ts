/**
 * Hand a relay's log lines to Claude and get back an account of what happened.
 *
 * There is no parser between the logs and the model on purpose. The router
 * writes zerolog JSON with the attributes flat at the top level, which reads
 * perfectly well as-is — and every message shape we'd otherwise hand-code is
 * one the model can already follow. What we DO structure is the answer, so the
 * page can lay it out and colour severity.
 *
 * The prompt below is the whole of this feature's domain knowledge. When the
 * explanations are wrong or thin, this is the file to edit.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { TraceExplanation, TraceLogLine } from "@sr/shared";
import { config } from "../config.js";

/** The model call failed. The route reports this rather than an empty answer —
 *  "we could not ask" and "there was nothing to say" are different facts. */
export class TraceExplainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceExplainError";
  }
}

const SYSTEM_PROMPT = `You explain single RPC relays to engineers operating the Magma Devs Smart Router.

## What the smart router is

It sits in front of raw blockchain RPC endpoints and multiplexes across them.
For one client request it picks an upstream provider, relays the request, and
may retry, hedge to a second provider, serve from cache, or cross-validate
answers between providers. Chains are identified by a Lava spec index (ETH1,
SOLANA, COSMOSHUB, BASE, ...). "Provider", "upstream" and "endpoint" all refer
to the node the router relays TO.

Every log line for one client request carries the same GUID. You are given all
of them, oldest first.

## How to read these logs

- They are zerolog JSON. Attributes are flat top-level fields, not nested.
- The "time" field is Unix NANOSECONDS. Convert before you state any duration.
- Some values are Go struct dumps, not clean strings: types without a String()
  method are formatted with %+v. In particular "provider" on a node-error line
  arrives like "{ProviderAddress:publicnode-eth ProviderQoSExcellenceSummery:...}".
  Read the address out of it; do not quote the dump at the reader.
- "GUID" and "seed" hold the same value.

## Messages that carry most of the meaning

Verified against a real trail — field names are exact.

- "Consumer received a new JSON-RPC request" / "... REST POST request" — the
  relay's entry. Carries the request body, the path and the dappID. There is NO
  equivalent line for the tendermintrpc or grpc interfaces, so a trace on those
  starts mid-story; say so rather than inferring a start.
- "Choosing providers" (INFO) — the routing decision. "validAddresses" is the
  pool considered, "chosenProviders" is what it picked, "ignoredProvidersList"
  is what it skipped. This is the line that answers "which upstream served
  this", and it is present even at info level.
- "Provider selection completed" (DEBUG) — WHY that provider won.
  "selection_mode" (e.g. weighted_random), "selected_provider",
  "selected_score", "selected_probability_pct", "num_candidates", and then a
  numbered block per candidate: "candidate_N_provider", "candidate_N_score",
  and its component scores "candidate_N_availability" / "_latency" / "_sync" /
  "_stake" / "_composite". Under weighted_random the highest score does NOT
  always win — it is a weighted draw, so a lower-scored provider being picked
  is normal and not a fault. Say so rather than reporting it as an anomaly.
- "sending direct RPC relay" / "direct RPC relay succeeded in goroutine"
  (DEBUG) — the actual upstream call. The success line carries "endpoint" and
  "latency" (a Go duration string like "257.209542ms") for THAT attempt.
- "calculated sync gap" (DEBUG) — how far behind the chain tip the upstream
  was: "endpoint_latest" vs "reference_tip", with "sync_gap" in blocks. A
  non-zero gap on the provider that served the relay is worth mentioning.
- "jsonrpc http" / "rest http" — the per-relay summary, written at DEBUG. Has
  "timeTaken" (the true END-TO-END duration, a Go duration string), the full
  "request" and "response", and "HasError". When present this is the single
  most authoritative line: prefer its timeTaken over any duration you compute
  from timestamps.
- "Relay received a node error" — an upstream answered with an error. Names the
  provider and the method.
- "provider blocked" — the router took a provider out of rotation. Carries
  "block_reason" (one of: all-endpoints-disabled, too-many-dead-sessions,
  never-served-successfully, explicit-block-signal, blocked-in-previous-epoch,
  unspecified), plus "detail", "scope", "blocked_count" and "valid_remaining".
  This is usually the most important line in a trace that has one.
- "CALCULATING VALID ADDRESSES" / "CALCULATION RESULT" / "VALIDATING PROVIDERS"
  — the candidate pool the optimizer chose between.
- "No providers returned by the optimizer" / "NO VALID PROVIDERS - TRIGGERING
  RESET" — the router ran out of usable upstreams.
- "No regular providers available, trying backup providers" and its outcomes —
  failover to the backup pool.
- "failed relay, insufficient results", "failed getting responses from RPC
  endpoints" — terminal failure of the relay.

## The rule that matters most

How much the router writes down depends on the level it runs at, and you are
not told which level that was — infer it from what you were given. At "info" a
relay still names its chosen provider ("Choosing providers") but records no
timing and no selection rationale; "debug" adds those. **Absence of a line
means the router did not record that fact — it never means the thing did not
happen.**

So: never infer which provider served a relay unless a line names it. Never
state a duration unless a line gives you one. Never describe a retry, a cache
hit or a cross-validation that no line mentions. When you cannot tell, put it
in notDetermined and move on. A short honest answer is worth more than a
complete-sounding one, and the notDetermined list is what tells this team which
logging to add.

Many lines are internal scheduling noise — "STARTING TASK CHANNEL LOOP",
"RECEIVED TASK FROM CHANNEL", "UPDATING BATCH", "LOOPING BACK TO RECEIVE NEXT
TASK", "GOROUTINES LAUNCHED". They confirm the relay progressed but carry no
information an operator needs. Do not narrate them step by step; the timeline
should read as what happened to the REQUEST, not as a trace of the runtime.

## Your answer

Reply with ONLY a JSON object, no prose around it, no markdown fence:

{
  "summary": "One paragraph. What was asked, on which chain, and how it went. Lead with the outcome.",
  "timeline": [{ "at": "clock time or offset from the first line", "what": "what the router did" }],
  "findings": [{ "severity": "info|warning|critical", "title": "short", "detail": "one or two sentences" }],
  "notDetermined": ["facts the logs do not record"]
}

timeline: only steps a line actually supports. Omit rather than pad.
findings: what an operator should act on or notice. Empty array when a relay
was unremarkable — do not manufacture concerns.
notDetermined: required, and rarely empty at info level. Be specific: prefer
"which upstream served the relay (not logged at info level)" over "some details".`;

/** Ask the model to account for one relay. Throws `TraceExplainError` when the
 *  call or the parse fails — never returns a partial answer. */
export async function explainTrace(
  guid: string,
  lines: TraceLogLine[],
  truncated: boolean,
): Promise<TraceExplanation> {
  if (!config.traceAi.apiKey) {
    throw new TraceExplainError("No ANTHROPIC_API_KEY is configured.");
  }

  const client = new Anthropic({ apiKey: config.traceAi.apiKey });
  const first = lines[0]?.tMs;
  const rendered = lines
    .map((l) => (first === undefined ? l.line : `[+${((l.tMs - first) / 1000).toFixed(3)}s] ${l.line}`))
    .join("\n");

  const userMessage = [
    `Relay GUID: ${guid}`,
    `Log lines: ${lines.length}${truncated ? " (TRUNCATED — this is the beginning of a longer trail; say so in notDetermined)" : ""}`,
    "",
    "Lines, oldest first. The [+Ns] prefix is the offset from the first line and is ours, not the router's:",
    "",
    rendered,
  ].join("\n");

  let raw: string;
  try {
    const res = await client.messages.create({
      model: config.traceAi.model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    raw = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (e) {
    throw new TraceExplainError(e instanceof Error ? e.message : String(e));
  }

  return parseExplanation(raw);
}

/**
 * Parse the model's JSON, tolerating a markdown fence around it.
 *
 * Exported for the tests: this is where a model that drifts from the format
 * would break the page, so it is worth pinning down separately from the call.
 */
export function parseExplanation(raw: string): TraceExplanation {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TraceExplainError("The model's answer was not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new TraceExplainError("The model's answer was not a JSON object.");
  }

  const o = parsed as Record<string, unknown>;
  const summary = typeof o.summary === "string" ? o.summary : "";
  if (summary === "") throw new TraceExplainError("The model's answer had no summary.");

  return {
    summary,
    timeline: Array.isArray(o.timeline)
      ? o.timeline.flatMap((s) => {
          if (typeof s !== "object" || s === null) return [];
          const step = s as Record<string, unknown>;
          const what = typeof step.what === "string" ? step.what : null;
          if (what === null) return [];
          return [{ at: typeof step.at === "string" ? step.at : "", what }];
        })
      : [],
    findings: Array.isArray(o.findings)
      ? o.findings.flatMap((f) => {
          if (typeof f !== "object" || f === null) return [];
          const finding = f as Record<string, unknown>;
          const title = typeof finding.title === "string" ? finding.title : null;
          if (title === null) return [];
          const sev = finding.severity;
          return [
            {
              severity: sev === "critical" || sev === "warning" ? sev : ("info" as const),
              title,
              detail: typeof finding.detail === "string" ? finding.detail : "",
            },
          ];
        })
      : [],
    // Required by the prompt, but never trust that — an empty list renders as
    // "nothing flagged", which is a claim we should only make if it was made.
    notDetermined: Array.isArray(o.notDetermined)
      ? o.notDetermined.filter((s): s is string => typeof s === "string")
      : [],
  };
}
