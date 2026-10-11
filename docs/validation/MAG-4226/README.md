# MAG-4226 local verification — 2026-10-11

The real customer case was reproduced with a Smart Router built from commit
`123ed29d9e85172c2c1cbc697f04ebb7695368e8`, a real Prometheus, the production
Fastify API and production Next.js images. Both UI modes were tested.

## Reproduce

From the dashboard repository, with a Smart Router checkout beside it:

```bash
SR_CONFIG_HOST=./docs/validation/MAG-4226/values.yml SR_SPEC=specs/ \
  docker compose -p mag4226-review -f docker-compose.yml \
  -f docs/validation/MAG-4226/compose.yml --profile router up --build -d
```

The config contains a direct public Ethereum endpoint and a switchable HTTP
proxy to that same public endpoint. The switchable URL remains in config
throughout. Send `eth_blockNumber` requests to `localhost:3360` and observe
`Lava-Provider-Address`. Once both upstreams have answered:

```bash
docker compose -p mag4226-review -f docker-compose.yml \
  -f docs/validation/MAG-4226/compose.yml stop upstream-switch
```

Keep sending requests on the chain. Inspect `localhost:7779/metrics`,
`localhost:8000/api/metrics/upstreams?window=1h` and the Metrics Upstreams tab.
An all-failed-poll diagnosis needs counter increases over the last five
minutes; successful polls from before shutdown must age out first.
Restore with the same compose command and `start upstream-switch`.

## Observed evidence

- Before shutdown, 60 real Ethereum requests succeeded: 29 via the switchable
  upstream and 31 via the direct upstream.
- During failover, some requests timed out or retried; after exclusion, **25
  consecutive requests returned HTTP 200 with real hex block numbers**, all
  with provider `eth-publicnode`.
- The dead upstream initially emitted health = 0. A later router epoch update
  reset its gauge to **1 while the URL was still dead**. This reproduces the
  need for the block-poll fallback, rather than assuming the gauge suffices.
- In that state, its 5-minute successful-poll increase was **0**, failed-poll
  increase was **positive** (about 4.2 after Prometheus extrapolation), and the
  API and both UI layouts reported **Unhealthy** with the poll-failure reason.
  Router health stayed operational and the header counted one unhealthy row.
- Restoring the upstream returned both API rows to Operational. Both HTTP
  health endpoints returned 200 / `Health status OK`, and the container health
  command returned top-level `ok: true`.

[Request provenance](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/before-traffic.json),
[requests after exclusion](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/excluded-traffic.json),
[real poll queries](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/stuck-real-polls.json),
[dead roster](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/dead-roster.json),
[overview counts](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/dead-overview.json),
[recovered roster](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/recovered-roster.json).

## UI and missing-data checks

A separate real Prometheus/API pipeline with a controlled exporter verified
health gauge = 1 + all-failed polls, and an empty endpoint telemetry store.
Configured rows remained visible as **Unknown warnings with a reason**, with
matching header counts. Historical success stayed separate from current
status. Headers showed Checking health… during delayed initial loads and made
no roster request on the Overview page. Both standalone layouts displayed the
unhealthy count. Router-filter changes showed loading and then the correct
count in both UIs; [filter evidence](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/bd8298f60c9823c9973717a2793e78e21a1752ae/filter-browser-results.json). [Browser results](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/browser-results.json).

![Real router failure — default UI](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/default-unhealthy.png)
![Real router failure — new UI](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/new-unhealthy.png)
![Missing endpoint telemetry is a warning](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/missing-default-unknown.png)

## Automated validation and limits

- `pnpm -r test`: **2,426 tests passed** across all four test packages.
- `pnpm -r typecheck`: passed.
- `pnpm lint`: zero errors, 30 existing warnings.
- A local merge of this change and the catalog resync passed all **2,442
  tests** and workspace typechecks; only the changelog needed reconciliation.
- Both Docker production images and the local router image built successfully.
- New implementation/test files pass Prettier; `git diff --check` passed.

The health window is fixed at five minutes, independent of request-history
filters. Poll success metrics count tracker events, not every HTTP response.
Prometheus needs two scrapes for counter increases, and ordinary instant
selector lookback applies to gauges. A mixed recent-success/failure window
does not alone override a healthy gauge.

**Cold-start limit:** when the URL is already dead at router startup, this
router can omit it from the active provider pool and publish neither health
nor poll series for it. The dashboard retains it as a visible missing-health
warning with its reason; it cannot claim a measured failure from absent
metrics. The real CLI health probe independently confirmed that endpoint
failed while its healthy peer worked. [Cold-start roster](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/cold-start-roster.json).

No customer's EC2 instance or provider configuration was accessed. The
published compose file selects a router image; older CLAUDE quick-start text
still describes a checkout build. This fixture explicitly builds the local
checkout and uses its bundled specs to avoid that mismatch.
