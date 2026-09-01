# Relay Trace — product review, and the work it implies

A review of the uncommitted Relay Trace feature (v0.20.3 → 0.21.0), written for
whoever implements the follow-ups. Every finding names the file, the change, and
how to tell it worked.

> **Showing this to the team first?** Read [`POC.md`](POC.md) instead. It
> re-prioritises this list for a demo — the visual and convenience work moves to
> the front, and finding 2 (Loki auth) drops off the runway entirely.

Reviewed against a live `make demo` stack on 2026-09-01: 14 real relays fired
through the router, traces pulled through `GET /api/trace/:guid` and read in the
browser at `/trace/<guid>`. `pnpm typecheck` clean, 25 trace tests passing.
The AI half was **off** on that stack (`TRACE_AI_ENABLED=false`), so findings
about the explanation itself come from reading
[`trace-explain.ts`](../../apps/api/src/services/trace-explain.ts) and the
render path, not from a live model answer.

**The short version.** The engineering is stronger than most things that ship —
the honesty contract survived contact with a language model, which is the hard
part, and it is done. Two things block the feature from reaching the people it
is for: nobody on call will ever have the GUID the page asks for, and the Loki
client cannot authenticate against any real log store. Both are cheaper than
what has already been built.

## Contents

| # | Finding | Priority |
|---|---|---|
| 1 | [The page asks for a GUID nobody has](#1-the-page-asks-for-a-guid-nobody-has) | P0 |
| 2 | [The Loki client cannot reach a real Loki](#2-the-loki-client-cannot-reach-a-real-loki) | P0 |
| 3 | ["No explanation" is the hero card out of the box](#3-no-explanation-is-the-hero-card-out-of-the-box) | P1 |
| 4 | [The log viewer is the fallback everyone lands on, and it is unreadable](#4-the-log-viewer-is-the-fallback-everyone-lands-on-and-it-is-unreadable) | P1 |
| 5 | [The timeline is built from shuffled input](#5-the-timeline-is-built-from-shuffled-input) | P1 |
| 6 | [Nothing is cached, and the rate limit is shared](#6-nothing-is-cached-and-the-rate-limit-is-shared) | P2 |
| 7 | [The page is a dead end](#7-the-page-is-a-dead-end) | P2 |
| 8 | [No facts strip — the page is all prose](#8-no-facts-strip--the-page-is-all-prose) | P2 |
| 9 | [Make the model checkable, not just visible](#9-make-the-model-checkable-not-just-visible) | later |
| 10 | [`notDetermined` is the roadmap, and it is thrown away](#10-notdetermined-is-the-roadmap-and-it-is-thrown-away) | later |
| 11 | ["Trace" promises spans](#11-trace-promises-spans) | later |

---

## 1. The page asks for a GUID nobody has

**P0** · `apps/web/src/app/(app)/trace/page.tsx` ·
`apps/web/src/components/trace/TraceSearch.tsx`

`/trace` opens as a bare search box in an empty page. It works only if you
already hold a relay identifier, and today exactly one surface hands you one:
the Try-me drawer's **explain this relay** link, for a relay *you fired
yourself*. That is the debugging situation nobody needs help with.

The real arrival is an alert, or a customer saying "requests were failing around
22:15". That person has a chain, a rough time and a symptom. They have no GUID,
and nothing on this page gets them one. The feature is currently reachable only
by the person who least needs it.

The fix is one query away, against the Loki this feature already requires:

```logql
{service="router"} | json | level="error" | GUID != ""
```

Run on the demo stack after `make demo-relays`, aggregated by GUID:

```
10299314860602530991   1 err   could not send relay to provider
17156107245360552663   5 err   failed processing responses from RPC endpoints
11255481141664194050   1 err   received node error reply from provider
13015321903729093220   1 err   received node error reply from provider
```

**Do this.** Land `/trace` on a *recent failing relays* list — chain, method,
first error message, time, GUID — each row a link to `/trace/<guid>`. The GUID
box stays as the secondary path, below the list.

Notes for the implementation:

- Loki has no `DISTINCT`. Query `query_range` with `direction=backward` and a
  bounded `limit`, then group by the parsed `GUID` field in the api. That is
  what produced the output above.
- Reuse the shared filter model: `useChainFilter()` for the chain, and the
  window catalogue for the range. Do **not** invent a second time-window
  vocabulary — see CLAUDE.md → "Time windows".
- The chain is on the log line, so the list can be chain-filtered without a
  Prometheus round trip.
- Keep the honesty contract: a deployment whose collector attaches a different
  stream selector will return nothing, and the empty state must say
  "no failing relays in this window" — never imply the router had none.

**Verify.** From a cold browser, with no GUID in hand, an operator can reach an
explanation of a specific failed relay in two clicks.

---

## 2. The Loki client cannot reach a real Loki

**P0** · `apps/api/src/services/loki-client.ts` · `apps/api/src/config.ts`

[`prometheus-client.ts`](../../apps/api/src/services/prometheus-client.ts)
carries basic auth and `X-Scope-OrgID` (`PromAuth` / `buildAuthHeaders`,
lines 31–51), documented in CLAUDE.md as the reason a per-tenant read proxy or
Mimir works at all. `loki-client.ts` was written as its deliberate twin — same
shape, same "empty result is a valid answer" stance — but sends **no headers**:

```ts
const res = await fetch(url, { signal: controller.signal });   // loki-client.ts:58
```

Every production log store is authenticated. Grafana Cloud wants basic auth;
multi-tenant Loki wants `X-Scope-OrgID`. Stacked on the limit
[`RELAY-TRACE.md`](RELAY-TRACE.md) already states — the smart-router chart ships
no Loki, only a `grafanaUrl` — the feature today has no deployment target
outside a laptop.

**Do this.**

1. Add `LOKI_USERNAME` / `LOKI_PASSWORD` / `LOKI_ORG_ID` to the `loki` block in
   `config.ts`, and reuse `buildAuthHeaders` — it is already exported and its
   "both halves or neither" rule (half a credential turns every query into a 401
   that reads exactly like "no data") applies here unchanged.
2. Make a 401/403 from Loki a distinct outcome. `LokiUnavailableError` currently
   folds it in with "unreachable", and a bad credential must not surface as
   "the log store is down".
3. Then decide the production path, deliberately: the chart gains Loki, or the
   api points at the customer's existing one. Until that is settled, everything
   else in this document is polish on a feature nobody outside the team can run.

**Verify.** `LOKI_USERNAME`/`LOKI_PASSWORD` set against a basic-auth-protected
Loki returns a trace; a wrong password returns a message that says
"authentication", not "unavailable".

---

## 3. "No explanation" is the hero card out of the box

**P1** · `apps/web/src/components/trace/TraceView.tsx:40,73–78,134–176`

`TRACE_AI_ENABLED` ships `false`, and rightly so — it spends tokens and sends
relay bodies to a third party. But that means the page most people meet first is
the one that got the least attention. Today, with the AI off, `/trace/<guid>`
renders:

```
┌──────────────────────────────────────────────┐
│ No explanation                               │
│ The AI explanation is turned off on this     │
│ deployment (TRACE_AI_ENABLED). The relay's   │
│ log lines are below.                         │
├──────────────────────────────────────────────┤
│ Log lines (30)                    [ Show ]   │
│ Searched back to 9/1/2026, 10:03:36 PM       │
└──────────────────────────────────────────────┘
```

A large card announcing what is missing, above a collapsed count of the only
content on the page. `showLines` defaults to `false` (line 40) even when the
lines are all there is.

**Do this.** When `explanation === null`, default `showLines` to `true` and
title the card *Log lines for this relay*, with the reason as a quiet footnote
rather than a heading. Same information; the page stops apologising for itself.

Keep `skipMessage()` as it is — the five distinct reasons are correct and are
one of the better decisions in this feature. Only the framing changes.

**Verify.** With `TRACE_AI_ENABLED=false`, a trace page shows log lines above
the fold with no click.

---

## 4. The log viewer is the fallback everyone lands on, and it is unreadable

**P1** · `apps/web/src/components/trace/TraceView.tsx:150–170` ·
`packages/shared/src/types/trace.ts:20`

Thirty lines of raw zerolog JSON, wrapped, undifferentiated. Two problems, both
cheap:

**Every line repeats what the page already shows.** `"GUID":"171561072453605
52663"` appears on all 30 lines — it is the value you searched for — and
`"time":1788290214832805336` duplicates the timestamp already printed in the
gutter. Roughly a third of each rendered line is data shown twice.

**`level` is captured and never used.** `TraceLogLine.level` is defined
(`types/trace.ts:20`), populated from Loki's stream labels
(`loki-client.ts:110`), returned by the api, and never rendered. On the failing
trace measured here:

```
{ "debug": 10, "error": 5, "info": 15 }
```

The five error lines — the only ones a reader wants — look exactly like the
fifteen info lines.

**Do this.**

- Colour/tag each line by `level`, using `HealthTag`'s vocabulary discipline: do
  not invent a fourth wording for a state the design system already names.
- Strip `GUID`, `time` and `level` from the *rendered* body. Parse the line as
  JSON, delete those three keys, render the rest; fall back to the raw string
  when the parse fails.
- Add an errors-only filter and a copy-all button.

None of this is the log parser the design correctly refuses. The model still
receives the raw lines, verbatim — this is presentation only, and
`RELAY-TRACE.md`'s "no parser" claim stays true. Say so in the code comment, or
someone will read the JSON handling as a violation of it.

**Verify.** On GUID `17156107245360552663`, the five error lines are findable at
a glance and each rendered line is materially shorter.

---

## 5. The timeline is built from shuffled input

**P1** · `apps/api/src/services/loki-client.ts:107–123`

`flatten()` truncates Loki's nanoseconds to milliseconds (line 114) and then
sorts on the millisecond (line 121):

```ts
const tMs = Number(BigInt(ns) / 1_000_000n);
...
out.sort((a, b) => a.tMs - b.tMs);
```

A router relay writes most of its trail inside one or two milliseconds, so the
ordering collapses exactly where the story is densest. Measured on GUID
`17156107245360552663` (30 lines):

```
lines sharing one millisecond    7, 6, 5, 3, 3, 2 …
out of order vs. router clock    10 of 29 adjacent pairs

rendered order                            router "time" (ns)
  1  🔎 CALCULATING VALID ADDRESSES         …832805336
  2  CALCULATION RESULT                     …832840503
  3  CrossValidation mode enabled           …832748128
  4  Consumer received a new JSON-RPC …     …832537253   ← the actual start
```

The relay's entry line renders fourth. The comment on line 118 is right that
lines land in several streams whenever the level changes mid-relay — it just
sorts on a key too coarse to separate them.

This matters more than it looks: `trace-explain.ts` tells the model the lines
are **oldest first** and asks it to produce a timeline. The timeline is the
product, and its input is shuffled.

**Do this.** Sort on the nanosecond value, keep milliseconds for display:

```ts
// keep the ns string; it is the only ordering key fine enough to separate
// lines the router wrote inside the same millisecond — which is most of them
out.push({ tMs: Number(BigInt(ns) / 1_000_000n), tNs: ns, line, level });
...
out.sort((a, b) => (a.tNs < b.tNs ? -1 : a.tNs > b.tNs ? 1 : 0));
```

Either add `tNs: string` to `TraceLogLine` or sort before mapping to the public
shape — the latter keeps the wire type unchanged and is probably preferable.
Note Loki's own entry timestamp and the router's `time` field are different
clocks; sorting on Loki's ns is correct and needs no JSON parse.

**Verify.** Extend `trace-route.test.ts`'s "oldest first" test with two lines in
the same millisecond, returned by Loki in the wrong order; assert the entry line
comes first.

---

## 6. Nothing is cached, and the rate limit is shared

**P2** · `apps/api/src/routes/trace.ts:32,89–102` ·
`apps/web/src/components/trace/TraceView.tsx:39,56–63`

`RELAY-TRACE.md` says a trace is "something you paste to whoever is on call".
The implementation does not behave like something that gets pasted.

**A trace is immutable history, and it is recomputed every time.** The lines for
a given GUID can never change, yet each open of the URL re-runs the model. Three
people opening the link you pasted get three billed calls and three subtly
different answers to a question with one fixed answer — and the second reader
cannot tell whether a difference from what you described is a model variation or
a real one.

**The limit is per IP.** `config: { rateLimit: { max: 10, timeWindow: "1 minute" } }`
— behind an ingress, every dashboard user shares one IP, so two engineers
debugging together lock each other out. It also applies with the AI **off**,
where the call is a cheap Loki read and there is nothing to protect. During this
review a handful of `curl` calls exhausted it, and the browser then showed:

```
Could not load this trace
Rate limit exceeded, retry in 2 seconds
```

A dead end: no retry button, and `useApi(..., 0)` does not poll, so the user's
only recourse is a manual reload.

**Do this.**

1. Cache explanations by GUID. An in-process LRU is enough — the answer is
   immutable, so there is no invalidation problem to design. Return a flag
   saying the answer was cached; the footer already has a place for it next to
   the model name.
2. Rate-limit the **model call**, not the route. With `TRACE_AI_ENABLED=false`
   the route should sit under the global `RATE_LIMIT_MAX` like everything else.
3. Give the error card a retry button that respects the stated wait. A 429 is
   the one error on this page that is guaranteed to succeed later.

**Verify.** Two consecutive loads of the same trace produce one model call; with
the AI off, twenty loads in a minute all succeed.

---

## 7. The page is a dead end

**P2** · `apps/web/src/components/trace/TraceView.tsx`

The explanation names an upstream, a chain and a method, and none of them go
anywhere. You read that `eth-publicnode` failed, and then navigate by hand to
the provider deep-dive that exists for exactly that. Three specific gaps:

- **No links out.** Upstream → the PM deep-dive (`endpointId` is the handle
  `/api/metrics/provider-detail` takes); chain → chain detail; and a **View full
  logs** link to Grafana, for which `DASHBOARD_GRAFANA_URL` already exists in
  config and already backs that button elsewhere in the app.
- **No copy-link**, on a page whose stated purpose is being pasted.
- **No way to re-run.** Re-submitting the same GUID in the box calls
  `router.push` to the route you are already on; SWR serves its cache and
  nothing visibly happens. Whether this becomes a real "re-explain" button
  depends on finding 6 — with caching, it is an explicit cache-bust.

**Verify.** From an explanation naming an upstream, its deep-dive is one click.

---

## 8. No facts strip — the page is all prose

**P2** · `apps/api/src/services/trace-explain.ts:119–134` ·
`apps/web/src/components/trace/TraceView.tsx:68–78`

Every other surface in this dashboard leads with values you scan in two seconds.
This one opens with a paragraph. The first questions are always the same —
which chain, which interface, which method, which upstream, did it succeed, how
long — and today you read for them.

**Do this.** Extend the model's JSON contract with a `facts` object of
explicitly nullable fields, and render it as the page header in the existing KPI
idiom:

```json
"facts": {
  "chain": "ETH1", "apiInterface": "jsonrpc", "method": "eth_getBalance",
  "provider": "eth-publicnode", "outcome": "failed",
  "httpStatus": 500, "durationMs": null, "retries": null
}
```

`null` renders `—`, which is the same honesty contract as the rest of the
product: at `info` the router logs no timing, so `durationMs` is *supposed* to
be null most of the time. Extend `parseExplanation()` the way it already handles
the other fields — drop anything malformed rather than guessing — and add a test
alongside "drops malformed timeline steps".

The prompt already forbids inventing these values (`trace-explain.ts:97–111`);
this only gives the model a structured place to put what it does find, and gives
the reader something skippable above the summary.

**Verify.** A trace page answers "which chain, which upstream, did it work"
without reading a sentence.

---

## 9. Make the model checkable, not just visible

**later** · `apps/api/src/services/trace-explain.ts`

`RELAY-TRACE.md` names verification as the first thing to add if this proves
valuable, and the current mitigation — lines on the same screen as the claim —
only works if someone reads thirty lines of JSON to audit a paragraph. Nobody
will, especially not at 3am, which is when this page is used.

**Do this.** Number the lines in the prompt (`[12] {"level":"info",…}`) and
require `lineRefs: number[]` on every timeline step and finding. Then each claim
renders as a link that scrolls to and highlights its evidence. A fabricated
claim becomes obvious instead of plausible, and a step whose `lineRefs` are
empty can be dropped by `parseExplanation()` before it ever reaches the page.

This also fixes a smaller thing: `TraceStep.at` is a model-authored string, so
its format drifts between "22:16:54" and "+0.3s". With a line reference, the
page derives the timestamp itself and the model stops being asked to format
time.

---

## 10. `notDetermined` is the roadmap, and it is thrown away

**later**

`RELAY-TRACE.md` calls this list "the most useful thing this feature produces":
per relay, what the router should have logged. It is computed, rendered once,
and discarded.

Counted across traces it becomes a ranked, evidence-backed list of logging gaps
for the router team — "47 traces could not report a duration", "12 could not
name the upstream" — which is an artefact this dashboard is uniquely placed to
produce and nobody else is producing. Two counters and a panel.

Do it only once explanations are cached (finding 6), or the counts measure page
reloads rather than relays.

---

## 11. "Trace" promises spans

**later** · `apps/web/src/components/gateway/nav.ts`

Every engineer arriving at a nav item called **Trace** expects OpenTelemetry: a
waterfall, spans, timings. This is a GUID-scoped log lookup with a written
explanation — a different thing, and in some ways a better one for this domain.
The name sets the wrong expectation before the page loads, and the page then
reads as a weak version of something it never was.

**Explain a relay** is what the landing card already calls it, and it is
accurate. `Relay trace` is the minimum.

---

## What is already right

Not padding — these are decisions worth preserving through the changes above.
Several of the fixes here could easily undo one of them by accident.

| | |
|---|---|
| **No log parser** | Structuring the answer rather than the input is the correct bet, and it is why the failure modes are honest. Finding 4 touches presentation only — keep the model's input verbatim. |
| **The degradation ladder** | AI off · Loki missing · Loki down · model failed · no lines. Five states, five distinct messages, none collapsed into "no data". Finding 2 adds a sixth (auth), and it must stay distinct too. |
| **Whitelist, not escape** | `isValidGuid` is what makes concatenated LogQL safe, and the tests say so by name. Any new query (finding 1) must derive its own inputs the same way — a chain filter taken from user input needs real escaping, not this pattern. |
| **`notDetermined` as a required field** | The best decision in the feature. It gives the model somewhere honest to put a gap instead of inventing a duration. |
| **The demo stack** | Four relays chosen for what each teaches, plus the measurement procedure and its traps. Use `make demo` + `make demo-relays` to reproduce every measurement in this document. |
| **Widening search windows** | 76 ms for a recent relay against 527 ms for a full-retention miss, measured here. The complexity earns its place. |

## Suggested sequence

1. **Sort on nanoseconds** (5). One line. Everything downstream assumes this
   order is real.
2. **Make the log view readable** (4, 3). Half a day, and it fixes the
   experience of the default deployment.
3. **Land `/trace` on recent failing relays** (1). The one change that makes the
   feature reachable by the people it is for.
4. **Cache by GUID; limit the model call, not the route** (6). Makes a shared
   link behave like a shared link.
5. **Decide the production path** (2). Loki auth, plus chart-or-customer-Loki.
6. **Facts strip, then evidence citations** (8, 9). Scannable first, then
   checkable.

## Housekeeping

`RELAY-TRACE.md` moved into this directory, so the links to `docs/RELAY-TRACE.md`
in **CLAUDE.md** (API endpoints table, env var table) and in the **CHANGELOG**
entry are now broken. Fix them in the same commit that lands any of the above.

## Related

- [`RELAY-TRACE.md`](RELAY-TRACE.md) — the feature's own reference: what the log
  trail contains at each router log level, the query, the answer shape.
- [`../../demo/README.md`](../../demo/README.md) — the demo stack, and the four
  relays worth tracing.
- `.claude/rules/testing.md` — every api route needs a happy-path
  `app.inject()` test with `fetch` stubbed; the trace tests already follow it.
