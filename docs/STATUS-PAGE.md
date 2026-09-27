# The Status page — what each section shows

The rule catalog behind `/status`. This is the reference the page used to
carry as its "What each section shows" table; it lives here so the page stays
an incident surface. Every rule is judged over the page's selected time
window (default 30 minutes) unless a row says otherwise. Derivations live in
`apps/api/src/services/status.ts`; every threshold below is asserted by
`apps/api/src/__tests__/status.test.ts`.

## The badge on an issue

Each chain's issue gets one badge. It answers one question: **can the chain
still be used?**

| Badge | When |
|---|---|
| **Critical** | The chain cannot be used: every provider on it is failing, or at least half of its requests got no answer after every retry. |
| **Degraded** | A provider is failing, slow or wrong, but the router can still send traffic to another one — even if some requests reached callers as errors. |
| **Config** | Nothing is failing because of us or a provider. The setup, or the caller's own requests, need to change. |

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
