# Try-me through the router, sent by the api

The **Try now** drawer's default mode, **Via router**, sends a request through
the router a customer calls. The dashboard api sends it, from inside the
deployment:

| `ROUTER_RELAY_ENABLED` | Who sends the router leg | Path |
|---|---|---|
| unset or `true` (default) | the dashboard api | browser → dashboard api → router's listener inside the deployment |
| `false` | the browser | browser → router's public address → router |

## Why the api sends it

A deployment can admit only a list of source addresses at its public hostnames;
on the fleet that is a Cloudflare custom rule per tenant (`edge_access.allow_ips`
in smart-router-infrastructure). A browser anywhere else gets a `403` from the
edge before the router sees the request, so Send, the WebSocket `online` check
and **Compare both** fail for anyone not on the list.

The api reaches the router without crossing the edge, so the drawer works
wherever the viewer is.

## Who can use it

Whoever can call the rest of `/api/*`:

| `AUTH_MODE` | Caller |
|---|---|
| `enabled` | a signed-in user, any role |
| `disabled` (default) | anyone who can reach the dashboard api |

> [!WARNING]
> With accounts off, anyone who can reach the dashboard api can send requests
> through the routers, whatever address list the public hostnames carry. Every
> check that lives at the edge or in the Gateway is skipped the same way: a
> request to the router's Service passes no origin-auth header check and, where
> the chart's `authGateway` is on, no API-key JWT check. Where that is not
> acceptable, turn accounts on, or set `ROUTER_RELAY_ENABLED=false`.

With `ROUTER_RELAY_ENABLED=false` both routes answer `404` and
`GET /api/config/routers` reports `routerRelay: false`, which is what the drawer
reads to send from the browser. The switch is the api's alone: the web has no
setting for it.

## Where the api dials

The caller names a router and an interface, never an address:

```jsonc
POST /api/routers/relay
{
  "routerId": "ETH1",            // as published by GET /api/config/routers
  "iface": "jsonrpc",            // the listener; a socket rides its base interface
  "transport": "http",           // or "ws"
  "httpMethod": "POST",
  "path": "/",                   // a REST call's path, a socket's /ws or /websocket
  "body": { "jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": [] },
  "selectProvider": "eth-publicnode",   // optional: lava-select-provider
  "forceCacheRefresh": true             // optional: lava-force-cache-refresh
}
```

The api works the address out of the mounted values file
(`ConfigurationService.resolveRouterOrigin`):

| Values file | Address |
|---|---|
| helm `routers:` | the router's Service, `<id lowercased>-router`, in the api's own namespace. The port follows the chart's rule: interfaces numbered by first appearance across the router's nodes, the Nth on `300<N>` (`helmServicePorts`). |
| SR_CONFIG | `ROUTER_RELAY_HOST` and the interface's listen port. The default is `localhost`; the compose stacks set `router`, their router service, and take `host.docker.internal` for a router run on the host. |

A WebSocket uses the same listener with the `ws://` scheme. A gRPC listener is
refused: neither transport speaks it.

An api that cannot reach the address answers `502` to every send. On an
SR_CONFIG deployment where the router is not at `ROUTER_RELAY_HOST`, set it, or
set `ROUTER_RELAY_ENABLED=false`.

## What crosses over, and what comes back

- **Sent:** the method, the path, the JSON body, and the two router directives:
  `lava-select-provider` and `lava-force-cache-refresh`, on HTTP only. The router
  reads no directives on a WebSocket. No other header of the caller's is
  forwarded. The path and query go on the wire as written, so a REST query
  reaches the router byte for byte as a browser sends it.
- **Returned:** `{ httpStatus, latencyMs, body, truncated, transport, servedBy,
  retries, cvStatus, cvAgreeing, cvDisagreeing }`. The last five are the
  router's `Lava-Provider-Address`, `Lava-Retries` and cross-validation headers,
  read on the server, so `cvStatus` is available too (a browser send never has
  it, because the router does not CORS-expose it). Nothing is redacted: these
  are the bytes the router gives any caller of its public hostname.

| Status | Meaning |
|---|---|
| `200` | The router answered. Its own status is `httpStatus`; a router `503` is a result to show, not a relay failure. |
| `400` | A gRPC listener, a path that is not one on this listener (no leading `/`, a leading `//`, a `.` or `..` segment, a backslash, spaces or control characters), or a `selectProvider` a header cannot carry (a control character, or one past U+00FF). Also a JSON body with a `__proto__` key, which the api refuses on every route. |
| `401` | Accounts are on and nobody is signed in. |
| `404` | The values file names no such router, or no listener for that interface. Also every call while `ROUTER_RELAY_ENABLED=false`. |
| `413` | The request body is over the api's 1 MiB limit. |
| `429` | The caller is past `ROUTER_RELAY_RATE_LIMIT_MAX` on this route for the minute, or already has two relays in flight. |
| `502` | The router could not be reached, or its answer broke off. On a WebSocket the drawer shows this as a failed result, like a browser socket that fails to open. |
| `503` | `ROUTER_RELAY_MAX_IN_FLIGHT` relays are in flight across all callers. |
| `504` | The router did not answer, or did not finish its answer, in time: `ROUTER_RELAY_TIMEOUT_MS` on HTTP, and no more than 15 s on a WebSocket. The drawer shows this as a timed-out result, like a browser send that times out. |

`POST /api/routers/ws-probe` takes `{ routerId, iface, path }` and answers
`{ online }`: whether the upgrade opened within 6 seconds.

## Limits

- **Per minute:** `ROUTER_RELAY_RATE_LIMIT_MAX` per caller, counted apart for the
  relay and the probe. The caller is the signed-in user, or the address with
  accounts off.
- **In flight:** two relays per caller, `ROUTER_RELAY_MAX_IN_FLIGHT` across all.
  A relay holds its reply several times over while it is read, parsed and sent
  on, so this, not the per-minute limit, bounds the api's memory.
- **Size:** an HTTP answer past `ROUTER_RELAY_MAX_BODY_BYTES` comes back cut
  there, `truncated: true`. A WebSocket message past it is refused from its
  frame header and not read: `truncated: true` with no body.
- **Sockets:** a WebSocket the router does not close within 2 s of the relay's
  close is dropped.

## What the drawer shows

- The address bar keeps the public address and its copy button, because that is
  what a client calls. A `sent from server` tag beside it says the Send does not
  dial it from the browser: a working Try-me is no proof that the viewer's own
  address is on the list.
- Latency is measured at the api, around its call to the router. In **Compare
  both** both legs are measured from the same place.
- The `ws` tag is the api's handshake with the router's listener. `unknown`
  means the api could not be asked, which says nothing of the listener.
- The code snippets still print the public address.

## Settings

| Variable | Default | |
|---|---|---|
| `ROUTER_RELAY_ENABLED` | `true` | exactly `false` turns both routes off and returns the router leg to the browser |
| `ROUTER_RELAY_HOST` | `localhost` | where an SR_CONFIG mount's routers listen; unused for a helm mount |
| `ROUTER_RELAY_TIMEOUT_MS` | `30000` | deadline on the api→router call, body included; a WebSocket send stops at 15 s |
| `ROUTER_RELAY_MAX_BODY_BYTES` | `4194304` | router answers past this come back `truncated: true` |
| `ROUTER_RELAY_RATE_LIMIT_MAX` | `60` | per caller per minute; the relay and the ws probe each count their own |
| `ROUTER_RELAY_MAX_IN_FLIGHT` | `8` | relays in flight across all callers; one caller holds two at most |
