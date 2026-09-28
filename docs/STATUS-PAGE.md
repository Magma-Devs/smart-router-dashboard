# The Status page — what each section shows

The rule catalog behind `/status`. This is the reference the page used to
carry as its "What each section shows" table; it lives here so the page stays
an incident surface. Every rule is judged over the page's selected time
window (default 30 minutes) unless a row says otherwise. Derivations live in
`apps/api/src/services/status.ts`; every threshold below is asserted by
`apps/api/src/__tests__/status.test.ts`.

## The badge on an issue

Each chain's issue gets one badge. It answers one question: **can what the
caller sends still be served?**

| Badge | When |
|---|---|
| **Critical** | The chain cannot be used: every provider on it is failing, or at least half of its customer requests failed after every retry (counted once per request, from the router's own final-result log). **Or one kind of request cannot be served:** at least half of the debug (or trace) calls got no usable answer — none at all, or an error reply like "the method does not exist" that no retry replaced. Reads may work, but those calls have no provider that serves them. **Or the caller cannot transact:** at least half of the transactions failed (the methods the router itself flags as writes; a failed transaction is found through its request id in the router's log). 3 calls or more in the window, for both. |
| **Degraded** | A provider is failing, slow or wrong, but the router can still send traffic to another one — even if some requests reached callers as errors. |
| **Config** | Nothing is failing because of us or a provider. The setup, or the caller's own requests, need to change. |

The page shows them in four sections, each with its meaning printed beside
its name: **Critical** ("The chain can't be used"), **Degraded** ("The chain
works, but some requests failed, got errors or waited"), **Handled by the
router** and **Refused by the chain** (the Config badge). Handled is a Degraded
issue the router covered completely — nothing failed for the caller, no error
reply reached them, and no saved request waited out a timeout first (a
provider refusing over its rate limit answers at once; one that does not
answer makes every saved request wait for its timeout, and stays Degraded).
It has no colour: amber on a chain the router covers every day teaches people
to ignore amber. `isHandled` in `apps/api/src/services/formulated-issues.ts`.

Under the four sections, **Risks** lists chains where nothing is failing yet
and one provider stands between them and failing: a chain with one provider,
debug (or trace) calls only one provider serves — the router filters
backups by add-on too, so those calls have nowhere else to go — or
transactions with one main provider: a transaction goes to every main
provider at once and one that fails is not retried elsewhere (the router's
retry policy stops a stateful request, since a write must not run twice). Only chains
with that traffic, and none with an open issue. `risksOf` in
`apps/api/src/services/issues-feed.ts`.

**Several chains failing at once** get their own card, on top of each chain's:
three or more chains whose worst five minutes overlap. Its cause is read, not
assumed — the provider every chain's traced requests failed on, when there is
one ("all on Tatum"), or "likely the Smart Router" when the chains share no
provider at all in the config. Written by code, not the model.

**Every card also says, in code-written lines:**

- **Who acts** — no one (the router is covering it), the provider at fault,
  whoever sends the refused requests, or Magma (several chains at once). Never
  how to fix it; that is the owner's call.
- **Request IDs and error codes** — the newest three request ids with their
  second, and the router's error names: what a caller's own log has, so
  support can match a complaint to a card.
- **A timeline** — one bar per five-minute check since the issue opened:
  failures, or what the router saved on a handled card, or what the chain
  refused on a caller card. A **NEW** tag marks issues opened in the last
  hour; one open past a day says how long ("3 days").

**Alerts.** Set `ISSUES_WEBHOOK_URL` and a chain turning Critical, and that
Critical issue resolving, is posted there as `{ text }` — which a Slack
incoming webhook posts as a message. Nothing else is sent, and nothing at all
without the url: who gets told is the operator's decision. The url usually
carries a secret and is never logged.

**A burst of failed customer requests opens an issue too**, whatever the rules
below say: more than five failed requests on a chain within five minutes —
the same line in the router's logs and the same test as the team's customer-
failure alert, so whenever that alert fires the page has an issue for it. The
burst joins the chain's issue if one is open. (This replaced the Live
incidents tab.)

**The numbers line.** Under each title, one line gives the chain's numbers
and the time they cover:

```
Last 30 min (22:21–22:51): 3 of 23,096 requests (0.01%) failed: no provider answered them. The router saved 135 others by trying another provider.
```

On the caller-side card the line counts what the chain refused — **once per
request**, from the router's log. The classified counter counts each
provider's reply, and a transaction goes to every primary at once, so it
counts one refusal once per primary (measured: 308 lines, 154 requests).
For refused transactions it also checks whether the same signed transaction
had been sent before, and says so ("All 6 transactions checked had been sent
before — the same transaction, up to 11 times"). That is the usual cause,
and the card states it instead of blaming the caller's code. Without the log,
the line says "refusals, one per provider a request went to", which is what
the counter's number is.

A card may not claim success: "succeeded", "went through", "accepted" are
checked in code (`claimsSuccess`), sent back to the model once, then dropped.
The router knows an answer came back — an error is an answer too — never
that a request succeeded.

Code writes it from the measurements (`impactOf` in
`apps/api/src/services/formulated-issues.ts`), never the model, and each word
means one thing:

| Words | Meaning |
|---|---|
| **failed: no provider answered them** | The router gave up — the final-result line in its log |
| **got a reply** | Something came back — an error reply included. When a provider is sending errors back, the line says so and names it |
| **saved** | Failed on one provider, answered by another |
| **did not work** | Debug or trace calls with no usable answer: none, or an error |
| **rejected** | The chain refused the request itself (the caller-side card) |

The time is part of the line on purpose. The page's window picks WHICH issues
show; the numbers always cover the last 30 minutes the api read (a resolved
issue shows the half hour it was last seen in). The model is told the line is
on screen, so it does not repeat the numbers and never writes a time word of
its own ("this week", "last time").

**What happened to the failed requests.** An issue with failed requests
lists each one's path through the router, one plain line per path:

```
40× getBlock · tatum ✕ timed out → +8s 3 backups (blockdaemon, lava, quicknode) ✕ none worked → failed at 30s
3× starknet_getEvents · alchemy ✕ timed out → +7s quicknode (backup) ✕ timed out → failed at 14s
```

That line is ONE request going through every provider on it — it answers
"was that the same request?", which "alchemy timed out on 3, quicknode on 2"
cannot. "+7s" is when the router sent the request to that provider, counted
from its arrival: the router adds a backup every few seconds without
cancelling the earlier attempts, so the steps overlap. Several backups tried
on one request are one step, named in a fixed order: which one the router
picks first changes from request to request, and grouping on the exact order
split one story into seventeen lines. Requests that went the same way are one
line with a count, grouped on the path without its times and shown at each
step's typical time.

It is rebuilt from the router's log by request id (`traceRequests` in
`apps/api/src/services/loki.ts`), from the lines that name a provider in a
field of their own; never from the error text, which carries the provider's
URL and key. Most attempts on a failed request log nothing of their own — the
provider was still working on it when the router gave up — so their word
comes from how the request ended: **no answer** when nothing came back to the
caller, **answered with an error** when a reply did and only one attempt was
silent, **result unknown** otherwise. A bad hour traces a sample — the newest
20 failed requests per pod — and the line says "N of M traced". A request
whose provider lines were not all read is left out rather than shown with a
gap.

**Where the failures come from.** Failed and refused requests are counted
from the routers' log store (`LOKI_URL`), once per request. A failure is the
request's final line — `ProcessingResult RETURNED` on older routers, `relay
finished` on newer ones, or `failed getting responses from RPC endpoints` —
with an `error`, `has_result: false` or `has_reply: false`: the same lines and
the same test as the team's customer-failure alert. A request that tried every
provider (`stop_reason: AllProvidersExhausted`) and still came back with a reply
and no error is a success — the page and the alert decide it the same way, on
purpose. Two store layouts are read:

| | Per-pod store (the default) | Shared store |
|---|---|---|
| `LOKI_SELECTOR` | `{service_name="router"}` | `{cluster="<cluster>",namespace="smart-router",component="router"}` |
| `LOKI_ROUTER_LABEL` | `pod` — `eth-mainnet-router-6b4d…` | `service_name` — `<cluster>-eth-mainnet` |
| The level | a label | only in the line (read from the line on both) |

The router label's value is matched to the values file's router ids: the
whole value, its start or its end, longest id first. A shared store's read
path takes `LOKI_USERNAME` / `LOKI_PASSWORD` (basic auth) and, where it asks
for one, `LOKI_ORG_ID`.

**Every failing chain gets a card.** The model writes at most 20 issues per
cycle. Past that, and whenever the model fails, an open issue keeps its words
with fresh numbers, and a new one gets a card written from its findings
("From the measurements only"), which the next cycle writes properly. The cap
used to limit detection itself, and an open issue that a cycle does not find
is resolved — so an outage wider than 20 chains showed chains that were still
down as resolved.

The rules below find the problems. The heading each rule sits under is its
own level, for one provider or one rule. It does not set the badge: a rule can
be Critical for one provider while the chain stays Degraded. Code:
`severityOf` in `apps/api/src/services/formulated-issues.ts`.

## Critical

| What | Meaning | How it is counted |
|---|---|---|
| **Chain down** | Every provider on the chain is failing. Nothing is serving. | every configured provider had ≥95% of its relays fail in the window, with at least 20 attempts · from rpc_endpoint_total_errored vs rpc_endpoint_total_relays_serviced |
| **Requests failed** | The router tried every provider and none answered - the callers got errors. | requests whose final error is PROTOCOL_NO_PROVIDERS, ALL_ENDPOINTS_DISABLED or INSUFFICIENT_PROVIDERS · from smartrouter_errors_total |
| **Too many errors** | Over 5% of a provider's answers are errors, refusals, or never come back. | (relays with no reply + error replies − unsupported-method calls) ÷ all answers, per provider per chain; needs ≥300 answers · from rpc_endpoint_total_errored + smartrouter_node_errors_total |
| **Frozen block height** | A provider keeps answering from an old block - answers look fine but are stale. Critical when it serves over 5% of the chain's answers. | the provider served relays while its reported block height did not change for 40× the chain's block time (floor 2 min) · from rpc_endpoint_latest_block |
| **Too slow** | Over 2% of answers take 10 seconds or more. | answers slower than 10s ÷ all answers · from the latency histogram's 10s bucket, smartrouter_end_to_end_latency_milliseconds |

## Degraded

| What | Meaning | How it is counted |
|---|---|---|
| **Increased errors** | 1–5% of a provider's answers are errors or never come back. Retries and failover hide it from users, at a cost. | same calculation as Too many errors, landing between 1% and 5% |
| **Answers not checked** | Nothing verifies the answers on this chain - a wrong or stale provider would be invisible. | zero minimum-block checks and zero cross-validation rounds while ≥300 relays were served · from smartrouter_consistency_total + cross_validation_requests_total |
| **Provider was serving stale answers** | A provider answered from old blocks in this window. The router caught it and rejected the answers. | reads that returned a block older than one already seen · from smartrouter_consistency_failed_total |
| **Getting slower** | Answers over 10 seconds are climbing compared to last week. | share of 10s+ answers vs the same window one week earlier; fires at 3× last week, or at 2% outright (then Critical) |

## Config

| What | Meaning | How it is counted |
|---|---|---|
| **Unsupported method** | Something calls a method no provider on this chain serves. | NODE_METHOD_NOT_FOUND / NOT_SUPPORTED / NOT_ALLOWED replies, ≥5 in the window · from smartrouter_errors_total |
| **Unsupported add-on** | Something calls an add-on (trace, debug, archive) no provider here has - or the config claims it and the provider does not serve it. | same codes, cross-checked against the add-ons the values file declares for that provider on that chain |
| **Cross-validation: not enough providers** | Answer verification is set to need more providers than this chain has, so it never runs. | cross-validation failures with an insufficient-* reason ÷ rounds, ≥5% · from smartrouter_cross_validation_failures_total |

## Insights

| What | Meaning | How it is counted |
|---|---|---|
| **Only one upstream configured** | The chain has a single upstream in the config. If it fails, the chain is down until a second one is added. | upstream count for the chain in the values file = 1 |
| **Backup unreliable** | The backup failed too often lately to be trusted in a failover. | minutes where ≥50% of its relays errored: over 8.5 of the last hour, or over 20 of the last 6 - burn-rate on a 1% error budget |
| **Slower than usual** | A provider is 2x+ slower than the same time last week. | average answer time vs the same window one week earlier; 2× and at least +200ms |
| **Failures creeping** | Failures below the alarm line, but several times the provider's own norm. | failure rate ≥3× the same window last week, while still under 1% |
| **Provider disagrees** | A provider's answers disagreed with the other providers' (needs cross-validation running). | disagreements ÷ (agreements + disagreements) over 7 days, ≥5% with ≥20 checks · from cross_validation_provider_disagreements_total |
| **Extra retries** | The router needs more attempts per request than normal to keep the chain flat. | upstream attempts ÷ customer requests: ≥1.25, or ≥1.1 and double the same window last week |

## Sources

- Counters and gauges: `smartrouter_*`, `rpc_endpoint_*` (see
  [`METRICS-MAPPING.md`](METRICS-MAPPING.md)).
- Error codes and their plain-words meanings:
  `packages/shared/src/constants/error-meanings.ts`.
- The "was … this time last week" references read the same window with
  `offset 7d` — one rule for every window length.
