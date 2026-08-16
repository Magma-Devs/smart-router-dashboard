# Direct-to-upstream testing

The Upstreams page's **Try now** drawer can send the same request two ways:

| Mode | Path | What it measures |
|---|---|---|
| **Via router** (default) | browser → router → upstream | What a real client gets. The router's cache can answer it, its retries and hedging can change who served it, and it reports all of that back in `Lava-*` headers. |
| **Direct to upstream** | browser → dashboard api → upstream | What the upstream does on its own. No cache, no retries, no hedging, no `Lava-*` headers — just the vendor's answer. |

**Compare both** — offered in direct mode, where there is a second leg to
compare against — fires them in sequence and puts the two answers side by side.

Every upstream row on the page carries its own Try-now, so the mode applies to
exactly one node url. What the drawer shows changes with it:

- **Via router** — the address bar shows the router's own url with a copy
  button, and the banner explains the `lava-select-provider` pin.
- **Direct to upstream** — the address bar shows the upstream's masked host
  followed by a dimmed `/…`, and the copy button gives way to a `url masked`
  tag: there is nothing to copy, because the dashboard never receives the
  full address.

A direct result reports what it can and nothing more — the latency, the
upstream's status, and a `direct · no router` tag where the `Lava-*` chips
would otherwise be.

## Why the api has to make the call

The browser cannot dial an upstream itself, for two independent reasons:

1. **It never holds the url.** `maskNodeUrl` (`apps/api/src/services/configuration.ts`)
   reduces every node url to `scheme://host` before the topology leaves the api,
   because upstream paths and query strings are where API keys live
   (`https://host/v2/<key>`, `?apikey=…`). The Upstreams page shows a masked host
   and nothing more.
2. **It shouldn't.** Shipping the credentialed url to the browser would hand the
   operator's vendor key to anyone with the dashboard open — and vendors don't
   answer cross-origin browser calls anyway.

So the api dials it. A direct call names an upstream by identity, not address:

```jsonc
POST /api/upstreams/relay
{
  "routerId": "ETH1",           // as published by GET /api/config/routers
  "node": "eth-publicnode",     // node name in the values file
  "endpointIndex": 0,           // which of that node's urls
  "transport": "http",          // or "ws"
  "httpMethod": "POST",
  "body": { "jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": [] }
}
```

```jsonc
// 200 — the UPSTREAM's status lives inside; see "Status codes" below
{ "httpStatus": 200, "latencyMs": 84, "body": { … }, "truncated": false, "transport": "http" }
```

`endpointIndex` is the endpoint's position in its node's list, published on
`GET /api/config/routers` as `nodes[].endpoints[].index`. It is assigned in the
same pass that builds the masked view (`ConfigurationService.normalize`), so the
index a row shows and the url the relay dials can never drift apart.

## What keeps it from being an open proxy

- **The target is never taken from the caller.** Only `{routerId, node, endpointIndex}`,
  resolved against the mounted values file. An unknown triple is a flat 404 with
  one message for all three failure kinds — the response teaches nothing that
  `GET /api/config/routers` didn't already say.
- **The resolved url is never returned**, never logged, and never put in a code
  snippet. Direct-mode snippets print `$UPSTREAM_URL` instead.
- **The upstream's own body is scrubbed** of anything derived from that url
  (`redactSecrets`) — vendors quote the request path in error bodies more often
  than you'd hope. Path segments and query values under 8 characters are left
  alone: they're `/evm` and `?height=42`, never keys.
- **REST paths are appended, not substituted.** `/blocks/latest` against
  `https://host/apikey-abc` dials `https://host/apikey-abc/blocks/latest`;
  `..`, `//host`, spaces and control characters are rejected.
- **Redirects are not followed** (`redirect: "manual"`) — a `Location` can carry
  the credentialed path onward to a host nobody vetted.
- **The caller's headers are dropped.** The relay sends only `accept` and, on a
  POST, `content-type`.
- **Bounded**: 10 s deadline, 256 KB response cap (`truncated: true` past it),
  20 requests/minute/IP.
- **gRPC upstreams are refused** — the relay has no gRPC client, so `grpcs://`
  endpoints are marked `directable: false` and rejected with that reason.

### REST and WebSocket

REST paths are appended to the upstream's own path, and the snippet shows the
same shape with `$UPSTREAM_URL` in front
(`curl -s "$UPSTREAM_URL/cosmos/base/tendermint/v1beta1/blocks/latest"`).

Switching the drawer to **WS** switches the direct target too — a node's `wss://`
url is a separate entry in the values file with its own index, and the api opens
a single-shot socket for it.

## Status codes

| Code | Meaning |
|---|---|
| `200` | The upstream answered. Its own status is in `httpStatus` — a 429 or 401 from the vendor is a successful measurement, not a dashboard error. |
| `400` | The request couldn't be built: bad path, transport/scheme mismatch, gRPC endpoint. |
| `404` | No such endpoint in the mounted config — or the relay is disabled. |
| `502` | Our hop failed: DNS, TLS, connection refused. |
| `504` | The upstream didn't answer inside the deadline. |

## Turning it off

```bash
UPSTREAM_RELAY_ENABLED=false   # 404s the route entirely
```

Worth a decision rather than a default: with `AUTH_MODE=disabled` (the default),
anyone who can reach the api can spend the operator's upstream quota through this
route — including write methods like `eth_sendRawTransaction` — using credentials
only the api holds. On a deployment where the dashboard isn't already restricted
to trusted users, turn it off or turn `AUTH_MODE` on.

Other knobs: `UPSTREAM_RELAY_TIMEOUT_MS`, `UPSTREAM_RELAY_MAX_BODY_BYTES`,
`UPSTREAM_RELAY_RATE_LIMIT_MAX`.

## Reading the comparison honestly

- **The two latencies come from different places.** The router number is measured
  in the browser, around a call to the router; the direct number is measured in
  the api, around its call to the upstream. The gap is a hint, not a benchmark —
  it includes neither the same client nor the same network path.
- **Differing bodies are usually fine.** Anything that tracks the head (block
  number, latest block, gas price) legitimately moves between two calls made a
  moment apart. A difference on a *fixed-height* read is the one worth chasing.
- **A cache hit makes the router look fast.** `Lava-Provider-Address: Cached` on
  the router leg means you're comparing a cache read against a network call.

## Where the pieces live

| Concern | File |
|---|---|
| Url resolution + index assignment | `apps/api/src/services/configuration.ts` |
| Dialing, redaction, caps | `apps/api/src/services/upstream-relay.ts` |
| Route, validation, status mapping | `apps/api/src/routes/upstreams.ts` |
| Request → relay payload (pure) | `apps/web/src/components/try-me/direct-request.ts` |
| Endpoint pairing per row | `apps/web/src/components/upstreams/catalog.ts` (`directTargetFor`) |
| Drawer UI, compare | `apps/web/src/components/try-me/drawer.tsx` |

One caveat worth knowing: an SR_CONFIG values file that gives **two providers on
the same chain the same `name`** collapses them into one relay identity (last one
wins), because the key is `(routerId, node, index)`. Name nodes uniquely — the
Upstreams page already groups by name, so duplicates were confusing before this
existed.
