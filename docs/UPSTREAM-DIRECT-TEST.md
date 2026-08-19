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
- **The upstream's own body is scrubbed** of anything derived from that url and
  of the endpoint's declared credential (`redactSecrets`) — vendors quote the
  request path in error bodies more often than you'd hope, and a 401 quotes the
  token. Path segments and query values under 8 characters are left alone:
  they're `/evm` and `?height=42`, never keys.
- **REST paths are appended, not substituted.** `/blocks/latest` against
  `https://host/apikey-abc` dials `https://host/apikey-abc/blocks/latest`;
  `..`, `//host`, spaces and control characters are rejected.
- **Redirects are not followed** (`redirect: "manual"`) — a `Location` can carry
  the credentialed path onward to a host nobody vetted.
- **The caller's headers are dropped.** The relay sends only `accept`, on a POST
  `content-type`, and the endpoint's own `auth-config` credential (below).
- **Bounded**: 10 s deadline, 256 KB response cap (`truncated: true` past it),
  20 requests/minute/IP.
- **gRPC upstreams are refused** — the relay has no gRPC client, so `grpcs://`
  endpoints are marked `directable: false` and rejected with that reason.

### The upstream's credential travels with the request

A vendor key does not always live in the url. `auth-config` on a node url puts
it in a header or a query string, and the router attaches it to every relay it
sends there:

```yaml
# helm values (the chart folds this into the router's own auth-config)
endpoints:
  - url: "https://gated.vendor.example/evm"
    interface: jsonrpc
    auth_config:
      auth_headers:
        Authorization: "Bearer 0f8d432c-18c2-47c0"
      auth_query: "apikey=abcdef123456"
```

The relay sends the same thing, so the direct leg is the router's leg minus the
router — not the router's leg minus its credential. The query string is appended
the way the router's own `AddAuthPath` appends it (`?` when the url carries no
query yet, `&` when it does), and the header rides the ws handshake too.

**Placeholders the values file doesn't resolve.** The chart runs `envsubst` over
the rendered router config, so a credential is often written `${VENDOR_TOKEN}`
and supplied to the router's container from `miscellaneous.routers.env`. The
relay resolves a placeholder against that block's literal `value:` entries —
and only those. A `secretRef` lives in a Kubernetes Secret the dashboard doesn't
mount, and the api's own environment is deliberately not a source: a values file
could otherwise name `${AUTH_SECRET}` and have the relay carry the dashboard's
signing key to an upstream host. When a placeholder can't be resolved the route
answers `422` naming what is missing, rather than dialing a literal `${VAR}` and
reporting the upstream's 401 as the upstream's verdict on the request.

### Backup-tier upstreams can only be reached direct

The router matches `lava-select-provider` against its **primary** pool and
nothing else. A provider declared under `backup-direct-rpc` (SR_CONFIG) or with
`is_backup: true` (helm values) lives in a separate pool it reaches only once
every primary is exhausted, and it chooses among those by QoS itself — the
header is never read on that path. Pinning a backup therefore answers:

```
-32000 Selected provider not available … {selectedProvider:blockdaemon,validProviders:tatum}
```

however healthy that upstream is. So the drawer opens a backup row on **Direct
to upstream** when the api can dial it — the one path that does reach a backup —
tags the row `backup`, and says why the router leg can't be pinned rather than
letting the reader learn it from a failed request.

**Via router is struck through and disabled** on such a row, and hovering it
gives the one-line reason. Every control that would fire the same doomed request
goes with it: **Compare both** (a refusal beside a real answer measures nothing)
and, where the row has no url the api can dial on the selected transport,
**Send** itself — with the same hint on the hover.

The per-upstream **Test connection** modal is pinned the same way, so on a
backup row it offers no run at all and points here instead.

The tier is read per endpoint row, not per upstream: one node can be primary on
one chain and backup on another.

### Naming an upstream

`node` is matched exactly first, then folded the way the pin header is folded
(lowercased, spaces to dashes — what the chart does to a values-file display
name on its way into the router's config). Both halves of the drawer therefore
address an upstream by one vocabulary, whichever casing the caller holds. A
folded name that two nodes in the same router answer to resolves to nothing:
dialing a coin-flip upstream is worse than a 404.

### REST and WebSocket

REST paths are appended to the upstream's own path rather than replacing it —
plenty of upstreams carry their key as a path segment (`https://host/v2/<key>`),
and replacing would turn a 200 into a confusing 404. Direct mode prints no code
snippets: the browser holds only `scheme://host`, so any command it could offer
would name a placeholder the reader has to resolve out of the values file first.

Switching the drawer to **WS** switches the direct target too — a node's `wss://`
url is a separate entry in the values file with its own index, and the api opens
a single-shot socket for it.

### Internal paths — where the two legs stop agreeing

A few specs split one interface across **internal paths**: TON serves the
toncenter v2 API and the tonindex v3 API as two REST collections, `/v2` and
`/v3`; AVAX splits jsonrpc into `/C/rpc`, `/P` and `/X`. The two legs address
those differently, and the drawer composes each one for you.

**Via router — send the api name, with no version prefix.** The router matches
REST by api name alone and then dials the upstream pinned to that name's
collection. A prefixed path matches nothing:

```console
$ curl -s localhost:3460/getMasterchainInfo     | head -c 60
{"ok":true,"result":{"@type":"blocks.masterchainInfo","last":…
$ curl -s localhost:3460/v2/getMasterchainInfo
{"code":12,"message":"Not Implemented","details":[]}
```

**Direct — the prefix depends on the upstream url.** The router keeps one proxy
per internal path and builds its url two ways, so the direct leg reproduces the
same arithmetic (`resolveDirectPath`, `src/components/try-me/direct-request.ts`):

| Values-file entry | Router's url for `/v2` | Direct leg sends |
|---|---|---|
| `url: …/api` (no `internal_path`) | `…/api` + `/v2` — auto-generated | `/v2/getMasterchainInfo` |
| `url: …tatum.io`, `internal_path: /v2` | the url as it stands | `/getMasterchainInfo` |
| `url: …/api/v3`, `internal_path: /v3` | the url as it stands | `/accountStates` |

Picking a `/v3` method while the drawer is aimed at a `/v2`-pinned upstream is
refused before Send: no prefix reaches it, and relaying the upstream's 404 would
read as a verdict on the request.

The command dropdown groups by internal path whenever a chain has more than
one, and the selected command carries its path as a tag — TON declares
`/estimateFee` under **both** v2 and v3, and they are different calls.

> **The router leg needs a router carrying the matching fix.** Selection of the
> direct-RPC upstream connection did not carry the internal path, so a `/v3`
> REST method could be dialed against the `/v2` upstream — observed against
> `toncenter.com/api` with both paths configured, where `/addressBook` (a
> v3-only name) came back in the v2 error shape. Fixed in smart-router
> (MAG-2881); a router built before that answers TON v3 out of whichever
> upstream selection happened to pick. The catalog and the direct leg here are
> correct either way.

## Status codes

| Code | Meaning |
|---|---|
| `200` | The upstream answered. Its own status is in `httpStatus` — a 429 or 401 from the vendor is a successful measurement, not a dashboard error. |
| `400` | The request couldn't be built: bad path, transport/scheme mismatch, gRPC endpoint. |
| `404` | No such endpoint in the mounted config — or the relay is disabled. |
| `422` | The endpoint's credential is named in the values file but not carried by it (an unresolved `${VAR}`, or a `secretRef`). Send that one through the router. |
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
| Url + `auth-config` resolution, index assignment | `apps/api/src/services/configuration.ts` |
| Dialing, redaction, caps | `apps/api/src/services/upstream-relay.ts` |
| Route, validation, status mapping | `apps/api/src/routes/upstreams.ts` |
| Request → relay payload (pure) | `apps/web/src/components/try-me/direct-request.ts` |
| Endpoint pairing per row | `apps/web/src/components/upstreams/catalog.ts` (`directTargetFor`) |
| Which upstreams the router can be pinned to | `apps/web/src/components/try-me/pin-support.ts` |
| Drawer UI, compare | `apps/web/src/components/try-me/drawer.tsx` |

One caveat worth knowing: an SR_CONFIG values file that gives **two providers on
the same chain the same `name`** collapses them into one relay identity (last one
wins), because the key is `(routerId, node, index)`. Name nodes uniquely — the
Upstreams page already groups by name, so duplicates were confusing before this
existed.
