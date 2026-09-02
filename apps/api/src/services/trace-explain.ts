/**
 * Hand a relay's log lines to a model and get back an account of what happened.
 *
 * Anthropic or Gemini, chosen by `TRACE_AI_PROVIDER` or inferred from whichever
 * key is set. Both get the SAME system prompt and the same JSON contract, so
 * the page renders either identically and answers stay comparable.
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
import { config, DEFAULT_TRACE_MODELS, type TraceAiProvider } from "../config.js";

/** The model call failed. The route reports this rather than an empty answer —
 *  "we could not ask" and "there was nothing to say" are different facts. */
export class TraceExplainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceExplainError";
  }
}

/**
 * No key for the chosen provider yet.
 *
 * Separate from `TraceExplainError` because it is a precondition the CALLER
 * can fix by typing, not a failure of the provider — and the settings picker
 * renders the two very differently. Conflating them made choosing a provider
 * the deployment has no key for look like that provider was broken.
 */
export class TraceKeyMissingError extends Error {
  constructor(
    message: string,
    readonly provider: TraceAiProvider,
  ) {
    super(message);
    this.name = "TraceKeyMissingError";
  }
}

/**
 * Output ceilings. A cut-off answer is unparseable JSON, not a short one, so
 * these are sized for the worst case rather than the typical one.
 *
 * They differ because Gemini's current flash models THINK, and thinking tokens
 * count against the same budget as the answer. Measured on a 30-line trace:
 * the answer is a steady ~600-700 tokens, but `thoughtsTokenCount` ranged
 * 692-1388 across runs — so a 2000 ceiling fits sometimes and truncates
 * sometimes, which is the worst possible failure mode. The headroom is not
 * spent unless the model uses it; billing is on actual tokens.
 */
const MAX_ANSWER_TOKENS: Record<TraceAiProvider, number> = {
  anthropic: 2000,
  gemini: 8000,
};

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
  "notDetermined": ["facts the router COULD have logged and did not"]
}

timeline: only steps a line actually supports. Omit rather than pad.
findings: what an operator should act on or notice. Empty array when a relay
was unremarkable — do not manufacture concerns.
notDetermined: things the router could have written down and did not — a
duration it never recorded, an upstream it never named. NOT things that are
unknowable in principle: what a request that timed out would have returned, or
what a provider that was never asked would have said, are not logging gaps and
do not belong here. Empty is a fine and common answer, especially at debug
level where the trail is nearly complete.

This field is for you, not for the reader: it is somewhere honest to put what
you could not tell, so you never fill a gap in the summary with a plausible
guess. Nothing renders it.`;

/** The key for the configured provider, or undefined when it is missing. */
function apiKeyFor(provider: TraceAiProvider): string | undefined {
  return provider === "anthropic" ? config.traceAi.anthropicApiKey : config.traceAi.geminiApiKey;
}

/** Whether an explanation can actually be produced: a provider AND its key. */
export function explainAvailable(): boolean {
  const p = config.traceAi.provider;
  return config.traceAi.enabled && p !== null && Boolean(apiKeyFor(p));
}

/** Credentials + model for one call. Absent fields fall back to the
 *  deployment's own configuration. */
export interface ExplainOverrides {
  provider?: TraceAiProvider;
  model?: string;
  /** Used for this call only. NEVER logged, persisted, or echoed back. */
  apiKey?: string;
}

export interface ExplainOutcome {
  explanation: TraceExplanation;
  provider: TraceAiProvider;
  model: string;
  usedCallerKey: boolean;
}

/**
 * Ask a model to account for one relay.
 *
 * Both providers get the SAME system prompt and are held to the same JSON
 * contract, so the page renders either identically and the answer can be
 * compared across them. Only the transport differs.
 *
 * A caller may bring its own provider, model and key — that is the
 * bring-your-own-key path, where each person spends their own budget and the
 * deployment holds no secret everyone who can reach it could spend. With no
 * override the deployment's own configuration answers. Throws
 * `TraceExplainError` when the call or the parse fails — never a partial
 * answer.
 */
export async function explainTrace(
  guid: string,
  lines: TraceLogLine[],
  truncated: boolean,
  overrides: ExplainOverrides = {},
): Promise<ExplainOutcome> {
  const usedCallerKey = Boolean(overrides.apiKey);
  const provider = overrides.provider ?? config.traceAi.provider;
  if (provider === null) {
    throw new TraceExplainError("No model provider is configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY).");
  }

  const apiKey = overrides.apiKey ?? apiKeyFor(provider);
  if (!apiKey) {
    throw new TraceExplainError(
      `No key for ${provider}. Paste one in Account settings, or set ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY"} on the deployment.`,
    );
  }

  // An override without its own model must not inherit the OTHER provider's
  // default — asking Gemini for "claude-sonnet-5" 404s in a confusing way.
  const model =
    overrides.model?.trim() ||
    (overrides.provider && overrides.provider !== config.traceAi.provider
      ? DEFAULT_TRACE_MODELS[overrides.provider]
      : config.traceAi.model);

  const userMessage = buildUserMessage(guid, lines, truncated);
  const raw =
    provider === "anthropic"
      ? await callAnthropic(apiKey, model, userMessage)
      : await callGemini(apiKey, model, userMessage);

  return { explanation: parseExplanation(raw), provider, model, usedCallerKey };
}

/** The lines as the model sees them, with our own relative-offset prefix. */
function buildUserMessage(guid: string, lines: TraceLogLine[], truncated: boolean): string {
  const first = lines[0]?.tMs;
  const rendered = lines
    .map((l) => (first === undefined ? l.line : `[+${((l.tMs - first) / 1000).toFixed(3)}s] ${l.line}`))
    .join("\n");
  return [
    `Relay GUID: ${guid}`,
    `Log lines: ${lines.length}${truncated ? " (TRUNCATED — this is the beginning of a longer trail; say so in notDetermined)" : ""}`,
    "",
    "Lines, oldest first. The [+Ns] prefix is the offset from the first line and is ours, not the router's:",
    "",
    rendered,
  ].join("\n");
}

async function callAnthropic(apiKey: string, model: string, userMessage: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  try {
    const res = await client.messages.create({
      model,
      max_tokens: MAX_ANSWER_TOKENS.anthropic,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (e) {
    throw new TraceExplainError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Gemini via the REST API rather than an SDK — one fetch, no extra dependency,
 * and stubbable in tests exactly like the Loki client is.
 *
 * `responseMimeType: "application/json"` is worth having: it constrains the
 * model to emit bare JSON, which is the drift `parseExplanation` otherwise has
 * to tolerate a markdown fence for.
 */
async function callGemini(apiKey: string, model: string, userMessage: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      // Header rather than ?key=, so the key never lands in a URL that some
      // proxy or access log might keep.
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: {
          maxOutputTokens: MAX_ANSWER_TOKENS.gemini,
          responseMimeType: "application/json",
        },
      }),
    });
  } catch (e) {
    throw new TraceExplainError(`Could not reach Gemini: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TraceExplainError(`Gemini answered ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }

  const json = (await res.json().catch(() => null)) as GeminiResponse | null;
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();
  if (text === "") {
    // An empty answer usually means the response hit the token ceiling or was
    // filtered — say which, rather than reporting "invalid JSON" downstream.
    const reason = json?.candidates?.[0]?.finishReason;
    throw new TraceExplainError(
      `Gemini returned no text${reason ? ` (finishReason: ${reason})` : ""}.` +
        (reason === "MAX_TOKENS"
          ? " Thinking tokens count against the output budget on Gemini's flash models — raise MAX_ANSWER_TOKENS.gemini."
          : ""),
    );
  }
  return text;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
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

/**
 * The models this provider will actually answer to, asked of the provider
 * rather than hardcoded.
 *
 * A checked-in list is wrong the week a provider ships or retires something —
 * which happened to this feature mid-build, when `gemini-2.5-flash` closed to
 * new users. Asking the provider means the picker is never stale, and it
 * validates the key as a side effect.
 */
export async function listModels(overrides: ExplainOverrides = {}): Promise<{
  provider: TraceAiProvider;
  models: { id: string; label: string }[];
  defaultModel: string;
}> {
  const provider = overrides.provider ?? config.traceAi.provider;
  if (provider === null) {
    throw new TraceExplainError("No model provider is configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY).");
  }
  const apiKey = overrides.apiKey ?? apiKeyFor(provider);
  if (!apiKey) {
    throw new TraceKeyMissingError(`Enter an ${provider} API key to load its models.`, provider);
  }

  const models = provider === "anthropic" ? await listAnthropic(apiKey) : await listGemini(apiKey);
  return { provider, models, defaultModel: DEFAULT_TRACE_MODELS[provider] };
}

async function fetchJson(url: string, headers: Record<string, string>, who: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new TraceExplainError(`Could not reach ${who}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TraceExplainError(`${who} answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json().catch(() => null);
}

async function listAnthropic(apiKey: string): Promise<{ id: string; label: string }[]> {
  const json = (await fetchJson(
    "https://api.anthropic.com/v1/models?limit=100",
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    "Anthropic",
  )) as { data?: { id?: string; display_name?: string }[] } | null;

  return (json?.data ?? [])
    .filter((m): m is { id: string; display_name?: string } => typeof m.id === "string")
    .map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
}

/**
 * Gemini lists ~50 models, most of which cannot do this job — image, TTS,
 * embedding and transcription models all advertise `generateContent`. The
 * provider's own capability flag is the primary filter; the name check is a
 * second pass for the ones it does not distinguish, and it is deliberately
 * narrow so a genuinely new text model is never hidden.
 */
const GEMINI_NOT_TEXT = /(^|-)(tts|image|embedding|transcribe|aqa|vision)(-|$)/;

async function listGemini(apiKey: string): Promise<{ id: string; label: string }[]> {
  const json = (await fetchJson(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    { "x-goog-api-key": apiKey },
    "Gemini",
  )) as {
    models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[];
  } | null;

  return (json?.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => ({ id: (m.name ?? "").replace(/^models\//, ""), label: m.displayName ?? m.name ?? "" }))
    .filter((m) => m.id !== "" && !GEMINI_NOT_TEXT.test(m.id));
}
