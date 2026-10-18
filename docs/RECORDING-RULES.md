# Recording rules

The dashboard reads every window from the raw router metrics unless the
Prometheus-compatible store behind it evaluates the recording rules below.
With them, windows of three hours and up read a few hundred recorded series
instead of every raw histogram bucket; without them everything still works,
only slower on long windows. This page is what to put in place, what it
changes, and how the dashboard behaves either way.

## What the rules do

Each rule is a two-minute rate of one counter family, evaluated once a
minute and summed to `cluster, chain, spec, router` plus at most one more
label — the labels the dashboard groups and filters by. On a deployment with
40 chains the router latency histogram is some 7,500 raw series and a
per-chain p95 over seven days costs seconds per read; the recorded buckets
are about 650 series and the same read is a fraction of that.

| Series | Summed by `cluster, chain, spec, router` and | Reads it |
|---|---|---|
| `spec_router:smartrouter_end_to_end_latency_milliseconds_count:rate2m` | — | requests served, RPS, the topbar pulse |
| `spec_router:smartrouter_requests_total:rate2m`, `…_success_total:rate2m` | — | availability, errors |
| `spec_router_le:smartrouter_end_to_end_latency_milliseconds_bucket:rate2m` | `le` | every latency quantile |
| `spec_router_provider:smartrouter_requests_total:rate2m`, `…_success_total:rate2m` | `provider_address` | the upstream roster |
| `spec_router_method:smartrouter_requests_total:rate2m`, `…_success_total:rate2m`, `…_read_total:rate2m` | `method` | the methods tab, errors by method |
| `spec_endpoint_le:rpc_endpoint_end_to_end_latency_milliseconds_bucket:rate2m` | `endpoint_id, le` | upstream latency panels |
| `spec_endpoint:rpc_endpoint_total_relays_serviced:rate2m`, `…_errored:rate2m` | `endpoint_id` | roster volume |

The dashboard then reads a window total as `sum_over_time(rule[W]) * 60`, a
ratio as the ratio of two such sums, a quantile as `histogram_quantile` over
the summed bucket rates, and the window before as the same read with
`offset W`. Measured against the raw reads on a store with the rules
evaluated over its history: window totals within 0.25 % at three hours and
0.17 % at a day and up, availability and error rate identical, quantiles
within 0.9 % and 0.17 %. Chart lines switch only from 12 hours up, where a
point is a two-minute average over the step; below that they read raw.

## How the dashboard behaves without them

Every builder has its raw form and emits it whenever the policy says so. The
api asks the store, on the first metrics request and once a minute after,
how old the newest recorded sample is and how far back the oldest one
reaches:

- no recorded series at all (no rules): every window reads raw;
- the series exist but the newest sample is older than five minutes (the
  ruler stopped, or is behind): every window reads raw until it catches up;
- the series are fresh but their history is shorter than a window (rules
  added an hour ago, a 3-day view): that window reads raw until the history
  covers it, twice over for a read that also wants the previous window;
- fresh and deep enough: windows of `METRICS_RECORDED_FROM` (default `3h`)
  and up read the recorded series.

`GET /api/metrics/reads` reports which case the deployment is in and which
windows read recorded series right now. `METRICS_RECORDED_FROM=never` holds
every window on raw reads regardless.

## The rules file

Copy this into the store's rule configuration for each tenant org. It is
plain Prometheus rule syntax, so it loads into a Prometheus `rule_files`
entry, a Mimir ruler namespace, or a Thanos / Cortex ruler unchanged. The
rules carry `cluster`, `chain`, `spec` and `router` because the router's
series carry them; a collector that names the router differently needs the
`by (…)` clauses adjusted to match.

```yaml
# Recording rules, evaluated once a minute in EVERY tenant's org — render-config.sh
# lays this file out once per tenant in tenants.yaml. Each rule is a two-minute
# rate of one counter family, summed down to the labels the readers group by:
# `cluster` (the tenant), `chain` and `spec` (the same value — the router sets
# both), `router` (the dashboard's per-router filter) and ONE more dimension.
# The dashboard reads these for windows of three hours and up:
#
#   a count over a window   avg_over_time(rule[W]) * W seconds
#   a ratio (availability)  avg_over_time(success[W]) / avg_over_time(total[W])
#   a quantile              histogram_quantile(q, sum by (…, le) (avg_over_time(bucket[W])))
#   the window before       the same with `offset W`
#
# so a p95 over seven days reads 645 series instead of the 7,530 raw bucket
# series on the largest tenant, and the upstream latency buckets collapse from
# 10,620 to 1,230. The war rooms group by (cluster, chain, method) over
# `$__range`; the method rules carry those too.
#
# Two-minute rates at a one-minute interval: the routers are scraped every 15 s,
# and a sample arriving late through a tenant's remote write still falls inside
# the window. The rate smooths one minute of edge per window, so a window total
# is within about 1% of a raw `increase()` at three hours and under 0.2% at a
# day; shorter windows stay on raw reads in the dashboard.
#
# What stays raw on purpose: gauges (health, scores, tips, in-flight), the small
# counter families (consistency, retries, node errors, classified errors, cache,
# cross-validation — a few hundred series at most, cheap at any window), and the
# per-method latency quantile (near raw cardinality, always read for one chain).
groups:
  - name: smartrouter-rates
    interval: 1m
    rules:
      # Client requests served (one increment per client request): the hero
      # "requests served", RPS and throughput series, the topbar pulse.
      - record: spec_router:smartrouter_end_to_end_latency_milliseconds_count:rate2m
        expr: sum by (cluster, chain, spec, router) (rate(smartrouter_end_to_end_latency_milliseconds_count[2m]))
      # Relays (per participant, probes included) and the successful ones:
      # availability = success / total, errors = total - success.
      - record: spec_router:smartrouter_requests_total:rate2m
        expr: sum by (cluster, chain, spec, router) (rate(smartrouter_requests_total[2m]))
      - record: spec_router:smartrouter_requests_success_total:rate2m
        expr: sum by (cluster, chain, spec, router) (rate(smartrouter_requests_success_total[2m]))
      # Latency histogram buckets: every p50/p95/p99 the dashboard shows —
      # account-wide (summed over spec), per chain, per router.
      - record: spec_router_le:smartrouter_end_to_end_latency_milliseconds_bucket:rate2m
        expr: sum by (cluster, chain, spec, router, le) (rate(smartrouter_end_to_end_latency_milliseconds_bucket[2m]))
      # Per provider: the upstream roster's volume and availability, the
      # overview's per-upstream RPS.
      - record: spec_router_provider:smartrouter_requests_total:rate2m
        expr: sum by (cluster, chain, spec, router, provider_address) (rate(smartrouter_requests_total[2m]))
      - record: spec_router_provider:smartrouter_requests_success_total:rate2m
        expr: sum by (cluster, chain, spec, router, provider_address) (rate(smartrouter_requests_success_total[2m]))
      # Per method: the methods tab, errors by method, the war rooms.
      - record: spec_router_method:smartrouter_requests_total:rate2m
        expr: sum by (cluster, chain, spec, router, method) (rate(smartrouter_requests_total[2m]))
      - record: spec_router_method:smartrouter_requests_success_total:rate2m
        expr: sum by (cluster, chain, spec, router, method) (rate(smartrouter_requests_success_total[2m]))
      - record: spec_router_method:smartrouter_requests_read_total:rate2m
        expr: sum by (cluster, chain, spec, router, method) (rate(smartrouter_requests_read_total[2m]))

  - name: rpc-endpoint-rates
    interval: 1m
    rules:
      # Per upstream endpoint, interfaces summed: the roster, the upstream
      # detail and peers panels read latency per endpoint; the roster and the
      # war rooms read relays served and errored.
      - record: spec_endpoint_le:rpc_endpoint_end_to_end_latency_milliseconds_bucket:rate2m
        expr: sum by (cluster, chain, spec, router, endpoint_id, le) (rate(rpc_endpoint_end_to_end_latency_milliseconds_bucket[2m]))
      - record: spec_endpoint:rpc_endpoint_total_relays_serviced:rate2m
        expr: sum by (cluster, chain, spec, router, endpoint_id) (rate(rpc_endpoint_total_relays_serviced[2m]))
      - record: spec_endpoint:rpc_endpoint_total_errored:rate2m
        expr: sum by (cluster, chain, spec, router, endpoint_id) (rate(rpc_endpoint_total_errored[2m]))
```

## Backfilling

Recorded series exist from the first evaluation after the rules are loaded.
To have them for history as well, evaluate the same file over the past with
`promtool tsdb create-blocks-from rules --url <store> --start … --end …
recording-rules.yaml` and load the resulting blocks into the store (Mimir:
`mimirtool backfill` with block upload enabled for the tenant). Until then
the dashboard reads the longer windows raw, as above.
