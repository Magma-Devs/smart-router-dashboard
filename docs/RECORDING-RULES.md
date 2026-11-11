# Recording rules

The dashboard reads every window from the raw router metrics unless the
Prometheus-compatible store behind it evaluates the recording rules below.
With them, windows of three hours and up read a few hundred recorded series
instead of every raw histogram bucket; without them everything still works,
only slower on long windows. This page is what to put in place, what it
changes, and how the dashboard behaves either way.

## What the rules do

Each rule is a 2m15s rate of one counter family, evaluated once a
minute and summed to `cluster, chain, spec, router` plus at most one more
label — the labels the dashboard groups and filters by. On a deployment with
40 chains the router latency histogram is some 7,500 raw series and a
per-chain p95 over seven days costs seconds per read; the recorded buckets
are about 650 series and the same read is a fraction of that.

| Series | Summed by `cluster, chain, spec, router` and | Reads it |
|---|---|---|
| `spec_router:smartrouter_end_to_end_latency_milliseconds_count:rate2m15s` | — | requests served, RPS, the topbar pulse |
| `spec_router:smartrouter_requests_total:rate2m15s`, `…_success_total:rate2m15s` | — | availability, errors |
| `spec_router_le:smartrouter_end_to_end_latency_milliseconds_bucket:rate2m15s` | `le` | every latency quantile |
| `spec_router_provider:smartrouter_requests_total:rate2m15s`, `…_success_total:rate2m15s` | `provider_address` | the upstream roster |
| `spec_router_method:smartrouter_requests_total:rate2m15s`, `…_success_total:rate2m15s`, `…_read_total:rate2m15s` | `method` | the methods tab, errors by method |
| `spec_endpoint_le:rpc_endpoint_end_to_end_latency_milliseconds_bucket:rate2m15s` | `endpoint_id, le` | upstream latency panels |
| `spec_endpoint:rpc_endpoint_total_relays_serviced:rate2m15s`, `…_errored:rate2m15s` | `endpoint_id` | roster volume |

The dashboard then reads a window total as `sum_over_time(rule[W]) * 60`, a
ratio as the ratio of two such sums, a quantile as `histogram_quantile` over
the summed bucket rates, and the window before as the same read with
`offset W`. Measured on the largest fleet tenant over six hours against the
exact counter delta (last sample minus first, no extrapolation): within
0.1 % on quiet and busy routers alike — a router with 101 requests read
101.0, one with 745,437 read 745,375. Availability and error rate are ratios
of the same sums; quantiles follow the buckets. Chart lines switch only from
12 hours up, where a point is a 2m15s average over the step; below that they
read raw.

## Why the window is 2m15s and not 2m

The routers are scraped every 15 seconds. A counter step — one request on a
series — sits inside a window of W seconds for W − 15 s, and the one-minute
evaluation grid hits that span (W − 15) / 60 times, each hit worth
60 / (W − 15) of the step. At W = 120 that is 1.75 hits: a busy series has
steps at every scrape phase and averages out to the true count; a quiet one
— a method called every few minutes, a provider relayed to once a minute —
always meets the grid at the same phase, so every one of its steps counts
once (0.571) or twice (1.143), at every window, forever. On the largest
tenant that put a quiet router at 57 % of raw over a backfilled month and
114 % on the live ruler, and low-volume methods, providers and chains off by
up to 43 % while headline totals were within 0.1 %. At W = 135 the span is
exactly two evaluations for every phase, each worth half a step:

| Router, 6 hours | Exact delta | `rate[2m]` | `rate[2m15s]` |
|---|---|---|---|
| avalanche-p-mainnet (quiet) | 101 | 115.4 | 101.0 |
| hedera-testnet | 2,154 | 2,210.3 | 2,155.5 |
| hedera-mainnet | 2,101 | 2,116.6 | 2,099.5 |
| near-mainnet | 231,849 | 231,762.9 | 231,865.5 |
| arbitrum-mainnet | 745,437 | 746,260.7 | 745,375.0 |

The one assumption is the 15-second scrape: a store on another interval
needs W = 2 × 60 s + that interval, and the api reads raw there (below). The
first generation of the rules (`…:rate2m`, 2026-10-15) had the phase bias;
nothing reads its series.

## How the dashboard behaves without them

Every builder has its raw form and emits it whenever the policy says so. The
api asks the store, on the first metrics request and once a minute after,
how old the newest recorded sample is, how far back the oldest one
reaches, and how far apart the raw router samples are:

- no recorded series at all (no rules): every window reads raw;
- the series exist but the newest sample is older than five minutes (the
  ruler stopped, or is behind): every window reads raw until it catches up;
- the series are fresh but the store does not scrape the routers every 15 s
  (the densest raw series over ten minutes is not 39 to 41 samples): every
  window reads raw, because the 2m15s window is exact only for that interval;
- the series are fresh but their history is shorter than a window (rules
  added an hour ago, a 3-day view): that window reads raw until the history
  covers it, twice over for a read that also wants the previous window;
- fresh and deep enough: windows of `METRICS_RECORDED_FROM` (default `3h`)
  and up read the recorded series.

`GET /api/metrics/reads` reports which case the deployment is in and which
windows read recorded series right now. `METRICS_RECORDED_FROM=never` holds
every window on raw reads regardless.

## The log store's counts

One more pair of recorded series lives in the same store, from another
ruler: the fleet Loki's, which counts the router's final log lines once a
minute into each tenant's org (devops-magmadevs,
`components/smart-router-fleet-loki/configs/recording-rules.yaml`):
`smartrouter_final_requests:count1m` and `smartrouter_final_failures:count1m`,
by `cluster`, `chain` (the router's network, lower case) and `service_name`
(`<tenant>-<router id>`). The Metrics page's Failed requests card reads
`sum_over_time` of the failures (`GET /api/error-requests/count`): about a
second for a month on the largest tenant, where counting the raw lines over
the same month scans some 1.6 TB. The api looks once a minute at how old the
newest sample is and how far back they reach: fresh, every window reads them,
and a window older than their history says where they start (`since`);
missing or older than five minutes, the card counts the raw lines, for a
window light enough to read in one go (`too-large` otherwise). They are not
part of the policy above: no `METRICS_RECORDED_FROM` floor, and no switch.

## The rules file

Copy this into the store's rule configuration for each tenant org. It is
plain Prometheus rule syntax, so it loads into a Prometheus `rule_files`
entry, a Mimir ruler namespace, or a Thanos / Cortex ruler unchanged. The
rules carry `cluster`, `chain`, `spec` and `router` because the router's
series carry them; a collector that names the router differently needs the
`by (…)` clauses adjusted to match.

```yaml
# Recording rules, evaluated once a minute in EVERY tenant's org — render-config.sh
# lays this file out once per tenant in tenants.yaml. Each rule is a 2m15s rate
# of one counter family, summed down to the labels the readers group by:
# `cluster` (the tenant), `chain` and `spec` (the same value — the router sets
# both), `router` (the dashboard's per-router filter) and ONE more dimension.
# The dashboard reads these for windows of three hours and up:
#
#   a count over a window   sum_over_time(rule[W]) * 60
#   a ratio (availability)  sum_over_time(success[W]) / sum_over_time(total[W])
#   a quantile              histogram_quantile(q, sum by (…, le) (sum_over_time(bucket[W])))
#   the window before       the same with `offset W`
#
# so a p95 over seven days reads 645 series instead of the 7,530 raw bucket
# series on the largest tenant, and the upstream latency buckets collapse from
# 10,620 to 1,230. The war rooms group by (cluster, chain, method) over
# `$__range`; the method rules carry those too.
#
# WHY 2m15s AND NOT 2m. The routers are scraped every 15 s (every tenant's
# Alloy config and the chart's ServiceMonitor default). A counter step sits
# inside a window of W seconds for W − 15 s; the one-minute evaluation grid
# hits that span (W − 15) / 60 times. With W = 120 that is 1.75: a busy series
# averages out, but a quiet one — a method called every few minutes, a
# provider relayed to once a minute — always meets the grid at the same phase,
# so every one of its steps counts once (0.571 of a step) or twice (1.143).
# Measured on the largest tenant: a quiet router at 57% of raw over a
# backfilled month and 114% on the live ruler, low-volume methods and
# providers off by up to 43% at every window, totals right. With W = 135 the
# span is exactly two evaluations for every phase, each worth half a step:
# over six hours on five routers the sums were within 0.1% of the exact
# counter delta, quiet and busy alike. The sum over a window therefore counts
# the same steps as a raw `increase()`, shifted one minute earlier; the one
# assumption is the 15-second scrape. A tenant scraping at another interval
# needs W = 2 × 60 s + that interval, and the dashboard reads raw there.
#
# What stays raw on purpose: gauges (health, scores, tips, in-flight), the small
# counter families (consistency, retries, node errors, classified errors, cache,
# cross-validation — a few hundred series at most, cheap at any window), and the
# per-method latency quantile (near raw cardinality, always read for one chain).
#
# The `:rate2m15s` suffix is the second generation. The first (`:rate2m`,
# 2026-10-15) carried the phase bias above; its samples stay in the stores as
# dead data until retention, because a block already merged by the compactor
# cannot be rewritten. Nothing reads them.
groups:
  - name: smartrouter-rates
    interval: 1m
    rules:
      # Client requests served (one increment per client request): the hero
      # "requests served", RPS and throughput series, the topbar pulse.
      - record: spec_router:smartrouter_end_to_end_latency_milliseconds_count:rate2m15s
        expr: sum by (cluster, chain, spec, router) (rate(smartrouter_end_to_end_latency_milliseconds_count[2m15s]))
      # Relays (per participant, probes included) and the successful ones:
      # availability = success / total, errors = total - success.
      - record: spec_router:smartrouter_requests_total:rate2m15s
        expr: sum by (cluster, chain, spec, router) (rate(smartrouter_requests_total[2m15s]))
      - record: spec_router:smartrouter_requests_success_total:rate2m15s
        expr: sum by (cluster, chain, spec, router) (rate(smartrouter_requests_success_total[2m15s]))
      # Latency histogram buckets: every p50/p95/p99 the dashboard shows —
      # account-wide (summed over spec), per chain, per router.
      - record: spec_router_le:smartrouter_end_to_end_latency_milliseconds_bucket:rate2m15s
        expr: sum by (cluster, chain, spec, router, le) (rate(smartrouter_end_to_end_latency_milliseconds_bucket[2m15s]))
      # Per provider: the upstream roster's volume and availability, the
      # overview's per-upstream RPS.
      - record: spec_router_provider:smartrouter_requests_total:rate2m15s
        expr: sum by (cluster, chain, spec, router, provider_address) (rate(smartrouter_requests_total[2m15s]))
      - record: spec_router_provider:smartrouter_requests_success_total:rate2m15s
        expr: sum by (cluster, chain, spec, router, provider_address) (rate(smartrouter_requests_success_total[2m15s]))
      # Per method: the methods tab, errors by method, the war rooms.
      - record: spec_router_method:smartrouter_requests_total:rate2m15s
        expr: sum by (cluster, chain, spec, router, method) (rate(smartrouter_requests_total[2m15s]))
      - record: spec_router_method:smartrouter_requests_success_total:rate2m15s
        expr: sum by (cluster, chain, spec, router, method) (rate(smartrouter_requests_success_total[2m15s]))
      - record: spec_router_method:smartrouter_requests_read_total:rate2m15s
        expr: sum by (cluster, chain, spec, router, method) (rate(smartrouter_requests_read_total[2m15s]))

  - name: rpc-endpoint-rates
    interval: 1m
    rules:
      # Per upstream endpoint, interfaces summed: the roster, the upstream
      # detail and peers panels read latency per endpoint; the roster and the
      # war rooms read relays served and errored.
      - record: spec_endpoint_le:rpc_endpoint_end_to_end_latency_milliseconds_bucket:rate2m15s
        expr: sum by (cluster, chain, spec, router, endpoint_id, le) (rate(rpc_endpoint_end_to_end_latency_milliseconds_bucket[2m15s]))
      - record: spec_endpoint:rpc_endpoint_total_relays_serviced:rate2m15s
        expr: sum by (cluster, chain, spec, router, endpoint_id) (rate(rpc_endpoint_total_relays_serviced[2m15s]))
      - record: spec_endpoint:rpc_endpoint_total_errored:rate2m15s
        expr: sum by (cluster, chain, spec, router, endpoint_id) (rate(rpc_endpoint_total_errored[2m15s]))
```

## Backfilling

Recorded series exist from the first evaluation after the rules are loaded.
To have them for history as well, evaluate the same file over the past with
`promtool tsdb create-blocks-from rules --url <store> --start … --end …
recording-rules.yaml` and load the resulting blocks into the store (Mimir:
`mimirtool backfill` with block upload enabled for the tenant). Until then
the dashboard reads the longer windows raw, as above. A backfill is tied to
the rule names it was made under: a later generation of the rules is
backfilled again under its own names, and the earlier series stay as dead
data until retention.
