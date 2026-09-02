# Relay Trace — explaining one relay from its logs

Two routes, because they are two decisions:

```
GET  /api/trace/:guid           the relay's log lines. No model call, no spend.
POST /api/trace/:guid/explain   Claude's account of them. Costs money.
```

Opening a trace is free and shows the lines; an **✦ Ask AI** button asks for the
explanation. Explaining on page load would bill the operator once per reader of
a link whose whole purpose is being pasted to whoever is on call, and would
leave no way to ask again when an answer is poor. The web surface is
**`/trace`**, with `/trace/<guid>` deep-linkable.

⚠ The **Look up** button next to the GUID box only navigates — it does not call
the model. Only **Ask AI** spends anything.

There is **no log parser**. The router's zerolog JSON goes to the model as it
was written. What we structure is the *answer*, so the page can lay it out.

## The GUID

Every relay gets one: `strconv.FormatUint(rand.Uint64(), 10)`
(`utils/uniqueIdentifier.go`) — a decimal number of up to 20 digits, **not** a
UUID. The router returns it in the **`Lava-Guid`** response header
(`protocol/common/endpoints.go:25`) and writes it into every log line for that
relay as a flat top-level `GUID` field.

The Try-me drawer reads that header and shows an **explain this relay** link on
the result, which is the fastest way to see this working. That link only appears
when the router CORS-exposes the header — both compose files list `Lava-Guid`
in `--cors-expose-headers`; a router started without it will withhold the value
from the browser and the link stays hidden.

Three sibling identifiers exist but are **not** used here: `X-Request-Id`,
`X-Task-Id` and `X-Tx-Id` become `request_id` / `task_id` / `tx_id` on the log
line (`utils/customIdentifiers.go`). They are caller-supplied strings, so
supporting them means real LogQL string escaping — the GUID needs none, because
a value that passes `isValidGuid` cannot contain a quote, brace or pipe.

## What the trail actually contains

⚠ **This is the thing to understand before judging an answer.** How much the
model has to work with is a property of the router's FLAGS, not of the relay.
Counts below are measured against the dev stack, not read off the source:

| Router flags | A successful relay leaves | A failed relay leaves |
|---|---|---|
| `--log-level info` (default) | **~11 lines**, including `Choosing providers` — `validAddresses`, `chosenProviders`, `ignoredProvidersList`. No timing, no selection rationale. Nothing at all on tendermintrpc or grpc, which have no entry line | **~20 lines** — the above plus `Relay received a node error` per attempt and the terminal failure. `provider blocked` carries a typed reason |
| `--log-level debug` | **~18 lines.** Adds `Provider selection completed` (the full scoring rationale), `calculated sync gap`, and the summary line with the real end-to-end `timeTaken` | **~31 lines.** Adds the cross-validation policy decision and each attempt's outcome |
| `+ --debug-relays` | + timeout schedule, agreement thresholds, per-result breakdown | + the full per-attempt result dump |

**Set `SR_LOG_LEVEL=debug` to see this at its best.** The per-relay summary is
written by `LogRequestAndResponse` (`protocol/metrics/rpcconsumer_logs.go:221`)
keyed on `msgSeed`, and `msgSeed := strconv.FormatUint(guid, 10)` — the same
string as the GUID — so it is found by the same query. It sits at Debug but is
**not** behind `--debug-relays`, so plain `debug` buys the whole success path
including real end-to-end timing.

The single richest line is `Provider selection completed` (debug): selection
mode (`weighted_random`), the winner and its score, then a numbered block per
candidate with component scores — availability, latency, sync, stake,
composite. ⚠ Under `weighted_random` **the highest score does not always win** —
it is a weighted draw, so a lower-scored provider being picked is normal and
must not be reported as an anomaly. The system prompt says so explicitly.

**The failure case works today with no router changes**: `provider blocked`
(`consumer_session_manager.go:2256`) with a typed `block_reason` from a closed
set of six, plus `detail`, `scope`, `blocked_count` and `valid_remaining`.

## The query

```logql
{service="router"} |= `<guid>` | json | GUID = `<guid>`
```

- The **line filter comes first**. Loki matches raw bytes far more cheaply than
  it parses them, so `|=` ahead of `| json` is the difference between a fast
  query and a timeout on a busy stream. The `| json` + field match after it is
  what keeps a coincidental substring hit out of the trail.
- The GUID stays a **parsed field, never a label** — it is per-request
  cardinality and a label would wreck the index.
- Input is **validated, not escaped** (`isValidGuid`): decimal digits, ≤ 20 of
  them, ≤ 2⁶⁴−1. That is the security boundary for a query built by
  concatenation.
- The window **widens** — 15m, 1h, 6h, 24h, 168h — stopping at the first hit,
  so a relay fired thirty seconds ago never costs a seven-day scan.

`LOKI_ROUTER_SELECTOR` overrides the stream selector: which labels a collector
attaches is a property of the deployment, the same reason `ROUTER_SCOPE_LABEL`
exists for Prometheus. The bundled Promtail sets `service` from the compose
service name.

## The answer

The model returns JSON the page renders directly:

| Field | Meaning |
|---|---|
| `summary` | One paragraph, outcome first |
| `timeline` | `{at, what}[]` — only steps a line actually supports |
| `findings` | `{severity, title, detail}[]` — `info` / `warning` / `critical` |
| `notDetermined` | **What the logs do not record** |

`notDetermined` is the one that earns its place. At `info` the router records no
timing at all, so a model asked "how long did this take?" will answer anyway
unless it has somewhere honest to put the gap — most easily by subtracting two
log timestamps, which measures the interval between two log writes and not the
relay. The system prompt (`apps/api/src/services/trace-explain.ts`) states the
rule directly — *absence of a line means the router did not record it, never
that the thing did not happen* — and requires the field.

That list is also the most useful thing this feature produces: it names, per
relay, what the router should have logged.

## Two providers, one contract

Either **Anthropic** or **Gemini** can answer. Set one key and the provider is
inferred from it; `TRACE_AI_PROVIDER` decides explicitly, and is only needed to
break the tie when both keys are set (anthropic wins by default).

Both get the **same system prompt** and are held to the same JSON contract, so
the page renders either identically and two answers to the same trace are
comparable. Only the transport differs:

- **Anthropic** goes through `@anthropic-ai/sdk`.
- **Gemini** goes over plain `fetch` to `v1beta/…:generateContent` — one
  request, no extra dependency, and stubbable in tests the same way the Loki
  client is. The key travels in the `x-goog-api-key` header rather than the
  query string, because a URL is the thing proxies and access logs keep. It
  also sets `responseMimeType: "application/json"`, which constrains the model
  to bare JSON — the drift `parseExplanation` otherwise absorbs with a
  markdown-fence fallback.

Both share one answer ceiling (`MAX_ANSWER_TOKENS`), so a cut-off answer is
unparseable JSON rather than a short one. Gemini reports that case as
`finishReason: MAX_TOKENS` and the error says so, rather than surfacing it as
"invalid JSON" and sending someone to debug the wrong thing.

⚠ **Model names move faster than this repository.** The defaults are
`claude-sonnet-5` and `gemini-3.6-flash`; if either 404s, set `TRACE_AI_MODEL`
rather than editing code. Google's 404 names the successor, which is how the
Gemini default got here — `gemini-2.5-flash` is closed to new users.

⚠ **Gemini's flash models think, and thinking counts against the output
budget.** Measured on a 30-line trace: the answer is a steady ~650 tokens, but
`thoughtsTokenCount` ranged **692–1388** across runs — so a 2000 ceiling fits
sometimes and truncates sometimes, surfacing as "The model's answer was not
valid JSON" on maybe one call in three. Hence the per-provider ceilings
(`MAX_ANSWER_TOKENS`): 2000 for Anthropic, 8000 for Gemini. The headroom costs
nothing unless it is used.

## Honesty and failure modes

- **The model is not verified against the lines.** Showing the raw lines under
  the answer is the mitigation, and an honest one only because they sit on the
  same screen as the claim. If this proves valuable, validation is the first
  thing to add.
- **"No log store" ≠ "relay not found".** An unset `LOKI_URL` returns 503
  `log_store_not_configured`; an unreachable Loki returns 503
  `log_store_unavailable`. Neither is ever an empty trace.
- **A failed model call does not fail the request.** The lines still come back,
  with `explainSkipped: "failed"` and the reason.
- **Truncation is reported.** A trail longer than `TRACE_MAX_LINES` comes back
  `truncated: true` and the model is told, so a cut trail is never mistaken for
  a short relay.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `LOKI_URL` | unset | Unset ⇒ 503 `log_store_not_configured`. Compose sets `http://loki:3100` |
| `LOKI_TIMEOUT_MS` | `10000` | Per-query abort |
| `LOKI_ROUTER_SELECTOR` | `{service="router"}` | Deployment-specific stream selector |
| `TRACE_MAX_LINES` | `400` | Lines sent to the model; oldest kept |
| `TRACE_AI_ENABLED` | `false` | Off unless set. Without it the page is a GUID-scoped log viewer |
| `TRACE_AI_PROVIDER` | inferred | `anthropic` \| `gemini` |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | unset | Set one. Server-side only; neither reaches the browser |
| `TRACE_AI_MODEL` | per provider | `claude-sonnet-5` / `gemini-3.6-flash` |
| `TRACE_AI_RATE_LIMIT_MAX` | `10` | Per IP per minute, tighter than `RATE_LIMIT_MAX` |

## Limits worth stating

- **Dev stack only for now.** The smart-router helm chart ships no Loki — only
  a `grafanaUrl` — so this works against the bundled `logs` profile and any
  self-hosted Loki, and not yet in a chart-deployed production.
- **Relay request bodies and headers reach Anthropic.** The router redacts
  upstream credentials before logging, so node-url API keys are safe, but the
  entry line carries the relay's own `body` and `headers`. Fine on the dev stack
  against public endpoints; it needs a deliberate decision before this points at
  anything carrying customer traffic. `TRACE_AI_ENABLED=false` is the off switch.
- **No entry line on tendermintrpc or grpc.** Those interfaces log no
  `Consumer received…` equivalent, so their traces start mid-story. A clean
  router-side follow-up — and exactly the kind of gap this tool exists to find.
