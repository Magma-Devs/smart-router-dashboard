# Demo stack — a real router to trace, and a way to measure it

`make demo` brings up the normal dashboard stack with a **real smart-router**
wired for two things the plain `make up` does not do:

1. **Relay Trace has something to explain.** The router runs at `--log-level
   debug`, so a *successful* relay leaves ~18 log lines instead of one. See
   [`../docs/RELAY-TRACE.md`](../docs/RELAY-TRACE.md).
2. **You can prove what the router sent upstream.** A counting proxy sits in
   front of one upstream and counts every request, keyed by JSON-RPC method —
   the node's own vantage point, from smart-router's `run-and-measure-locally`
   skill.

```bash
make demo          # up (router + Loki/Grafana + counting proxy)
make demo-relays   # fire a spread of relays, print each Lava-Guid
make demo-health   # endpoint/chain state — is this run trustworthy?
make demo-stats    # what actually reached the upstream node
make demo-down
```

| | |
|---|---|
| UI | <http://localhost:3000> — Trace page at `/trace` |
| API | <http://localhost:8000> — `GET /api/trace/:guid` |
| Grafana | <http://localhost:3001> (admin/admin) |
| Prometheus | <http://localhost:9090> |
| Router `/debug/*` | <http://localhost:7999/debug/endpoint-state> |
| Counting proxy | <http://localhost:8899/__stats> |
| Router relays | `:3360` ETH1 · `:3361` SOLANA · `:3362` BTC · `:3363` HYPERLIQUID · `:3364-6` COSMOSHUB rest/tm/grpc · `:3367` APT1 |

## Tracing a relay

Every relay gets a GUID, returned in the **`Lava-Guid`** response header and
written into every log line for that relay. `make demo-relays` prints it:

```
CHAIN        METHOD                             HTTP      TIME  LAVA-GUID
ETH1         eth_blockNumber                    200      346ms  16020572969786642994
ETH1/xval    eth_getBalance                     200      367ms  15900346227369301017
ETH1/fail    eth_getBalance                     500      384ms  4086162467114238055
```

Then open `http://localhost:3000/trace/<guid>`, or:

```bash
curl -s localhost:8000/api/trace/<guid> | jq '.lines | length'
```

Four relays are worth showing, in this order:

| Relay | Why |
|---|---|
| `ETH1/fail eth_getBalance` (500) | The richest trail — ~31 lines: pool decision, per-provider selection with scores, the error. Failures work at *any* log level. |
| `ETH1/xval eth_getBalance` (200) | Carries a cross-validation policy, so the trail shows `CrossValidation mode enabled (policy-resolved)` and a fan-out across two vendor groups. |
| `ETH1/fail eth_notARealMethod` (**200**) | A node error inside an HTTP 200 body. Shows why "did it succeed?" is not the same question as "what status came back?". |
| `COSMOS/tm /status` | tendermintrpc logs no `Consumer received…` entry line, so its trace starts **mid-story** — a real gap in the router, and exactly what `notDetermined` exists to name. |

### The AI explanation is off by default

`TRACE_AI_ENABLED=false` ships off, and without it `/trace` is a GUID-scoped log
viewer. Turning it on sends the relay's log lines — **request bodies and headers
included** — to Anthropic:

```bash
TRACE_AI_ENABLED=true ANTHROPIC_API_KEY=sk-ant-... make demo
```

Fine against these public endpoints. It needs a deliberate decision before it
points at anything carrying customer traffic.

## Measuring what goes upstream

`demo/values.demo.yml` is the dev topology with one change: the ETH1
`publicnode` group's HTTP leg points at `http://counting-proxy:8899`, which
forwards verbatim to `https://ethereum-rpc.publicnode.com` and counts. Every
other endpoint talks to its vendor directly, so the counter is scoped to
**exactly one endpoint**.

```bash
curl -s localhost:8899/__stats  | jq   # counters, outcomes, upstream RTT
curl -sX POST localhost:8899/__reset   # zero them
```

Requests are counted **before** they are forwarded, so nothing can reach the
node uncounted. `by_outcome` is recorded too: without it you cannot rule out
that failed upstream calls tripped the ChainTracker's failure backoff and
changed the very cadence you are measuring.

### The procedure that gives a number you can quote

1. `make demo`, wait for `make demo-health` to look clean.
2. **Settle 45s**, then `make demo-reset` — this excludes one-off startup
   verification traffic.
3. Measure a fixed window (180–300s).
4. `make demo-stats`.
5. **Send no relays** if you want *proactive* polling only. A relay both adds
   to the count and trips the traffic gate, which suppresses polls — mixing
   the two gives a number that means nothing.

### Always cross-check against theory

The poll cadence is `average_block_time / divisor` (divisor default 2), which
`make demo-health` reports as `PollIntervalMs`. Expected polls in a window are
computable from that and are independent of this harness:

```
ETH1 PollIntervalMs 6500 → 180s / 6.5s ≈ 27.7 latest-block polls
```

A run of exactly that procedure on 2026-09-01, ETH1 · publicnode, no relays:

```json
{ "window_seconds": 180.1, "total": 26, "requests_per_min": 8.66,
  "by_method":  { "eth_blockNumber": 26 },
  "by_outcome": { "200": 26 },
  "upstream_rtt_ms": { "avg": 520.84, "p50": 312.51, "p95": 1338.87 } }
```

26, not the 27.7 the naive formula predicts — and the gap is the point. The
poll timer restarts *after* the fetch returns, so the real period is
`fetch + interval` = `0.52s + 6.5s` = 7.02s → `180 / 7.02` ≈ **25.6**. The
measurement agrees with theory once the fetch duration is in it, which is why
`upstream_rtt_ms` is reported next to the count and not buried.

Two other things this run says out loud: `by_method` is **only**
`eth_blockNumber` — fork detection contributed nothing, matching
`HashPolling: off-operator-choice` in `make demo-health`; and `by_outcome` is
100% `200`, so no upstream failure tripped the tracker's backoff and distorted
the cadence.

If measured and expected disagree, **the harness is wrong** — investigate
before reporting the number.

### Traps that produce wrong numbers

- **The poll timer restarts *after* the fetch**, not on a fixed schedule, so the
  effective period is `fetch duration + interval`. On a slow upstream a version
  that does more work per cycle throttles its own poll rate — which can make the
  *more* efficient version look like it polls more. Always quote the upstream
  RTT (`upstream_rtt_ms` in `/__stats`) next to any comparison.
- **The websocket leg is not counted.** The proxy is HTTP-only, so
  `wss://ethereum-rpc.publicnode.com` stays direct and its traffic is out of
  scope by design.
- **Public vendors are not a controlled upstream.** They rate-limit and their
  RTT wanders (p50 ~0.3 s here, with occasional multi-second outliers). For a
  number you will show a customer, repoint the proxy at a fast local node:
  `DEMO_UPSTREAM_URL=http://host.docker.internal:8545 make demo`.

## Comparing two router versions

`SR_ROUTER_IMAGE` selects the image, so an A/B is two runs of the same command.
The counting proxy is the only method that works here: the router's own
`rpc_endpoint_tracker_requests_total` does not exist before v1.3.3, so a
router-side comparison across that boundary is impossible.

```bash
SR_ROUTER_IMAGE=ghcr.io/magma-devs/smart-router:v1.3.2 make demo
#   settle 45s → make demo-reset → wait 300s → make demo-stats
SR_ROUTER_IMAGE=ghcr.io/magma-devs/smart-router:v1.3.3 make demo
#   same again
```

## Health check for any run

`make demo-health` — every endpoint `Enabled=true` with
`ConsecutivePollFailures=0`, `PollIntervalMs` at the expected cadence,
`TipFresh=true` in chain-state, and no `error`/panic lines in
`make demo-logs`. `ConsensusBaseline=0` / `HasBaseline=false` is **normal** with
one or two endpoints per chain and is not a fault.

QoS scores need time to converge — sampling seconds after startup shows
artificially low availability, so give a run comparable traffic and settling
time before calling a difference a regression.

## Known upstream flakiness (not this stack's doing)

Two providers in `values.demo.yml` are dropped at startup by the public vendors
themselves; the demo works without them, and both are visible in
`make demo-logs`:

- **`eth-tenderly`** — its `wss://` leg EOFs during connect, and a failed
  websocket connector excludes the whole provider, HTTP leg included. ETH1 keeps
  `publicnode` + `mevblocker`, which is still the two groups the `eth_getBalance`
  cross-validation policy needs.
- **`cosmos-grpc-publicnode`** — gRPC startup verification fails to parse the
  vendor's response (`proto: bad wiretype`). COSMOSHUB gRPC runs on `polkachu`
  alone.
- **`aptos-labs`** — **HTTP 429**. Aptos's block time puts `PollIntervalMs` at
  100 ms, and the free endpoint rate-limits the ChainTracker long before any
  relay arrives. `make demo-health` shows it as the one row with a non-zero
  `FAILS` and a `POLLms` backed off to 60000, with its `LATEST` frozen while
  `aptos-rest.publicnode.com` keeps advancing. Worth knowing: a stuck endpoint
  looks identical to a consistency problem from the relay side, so check the
  poll failures before blaming block heights.
