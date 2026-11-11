# Try-me through the router, sent by the api

The **Try now** drawer's default mode, **Via router**, sends a request through
the router a customer calls. Who sends it depends on whether the deployment has
accounts:

| `AUTH_MODE` | Who sends the router leg | Path |
|---|---|---|
| `disabled` (default) | the browser | browser → router's public address → router |
| `enabled` | the dashboard api | browser → dashboard api → router's listener inside the deployment |

## Why the api sends it

A deployment can admit only a list of source addresses at its public hostnames;
on the fleet that is a Cloudflare custom rule per tenant (`edge_access.allow_ips`
in smart-router-infrastructure). A browser anywhere else gets a `403` from the
edge before the router sees the request, so Send, the WebSocket `online` check
and **Compare both** would fail for anyone not on the list.

The api reaches the router without crossing the edge, so the drawer works
wherever the viewer is.

## Why only with accounts on

Without accounts the dashboard api answers anyone who can reach it. A route that
sends requests through the routers from inside the deployment would let anyone
on the internet past the address list. So `POST /api/routers/relay` and
`POST /api/routers/ws-probe` are registered only with `AUTH_MODE=enabled`, behind
the same gate as every other `/api/*` route. Any signed-in role may use them,
because Try-me is open to every viewer.

This sets a deliberate posture: on a tenant with an address list, every
signed-in dashboard user can send requests through its routers from anywhere.
Removing someone's account removes that. The same holds for every other check
that lives at the edge or in the Gateway rather than in the router: a request
to the router's Service passes no origin-auth header check and, where a tenant
turns on the chart's `authGateway`, no API-key JWT check either. The dashboard
login stands in for all of them.

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

## What crosses over, and what comes back

- **Sent:** the method, the path, the JSON body, and the two router directives:
  `lava-select-provider` and `lava-force-cache-refresh`, on HTTP only. The router
  reads no directives on a WebSocket. No other header of the caller's is
  forwarded.
- **Returned:** `{ httpStatus, latencyMs, body, truncated, transport, servedBy,
  retries, cvStatus, cvAgreeing, cvDisagreeing }`. The last five are the
  router's `Lava-Provider-Address`, `Lava-Retries` and cross-validation headers,
  read on the server, so `cvStatus` is available too (a browser send never had
  it, because the router does not CORS-expose it). Nothing is redacted: these
  are the bytes the router gives any caller of its public hostname.

| Status | Meaning |
|---|---|
| `200` | The router answered. Its own status is `httpStatus`; a router `503` is a result to show, not a relay failure. |
| `400` | A gRPC listener, a path that fails `buildTargetUrl`'s checks (`//host`, `..`, spaces or control characters), or a `selectProvider` a header cannot carry (a control character, or one past U+00FF). |
| `401` | Not signed in. |
| `404` | The values file names no such router, or no listener for that interface. |
| `429` | This user is past `ROUTER_RELAY_RATE_LIMIT_MAX` on this route for the minute. |
| `502` | The router could not be reached, or its answer broke off. |
| `504` | The router did not answer, or did not finish its answer, within `ROUTER_RELAY_TIMEOUT_MS`. The drawer shows this as a timed-out result, like a browser send that times out. |

`POST /api/routers/ws-probe` takes `{ routerId, iface, path }` and answers
`{ online }`: whether the upgrade opened within 6 seconds.

## What the drawer shows

- The address bar keeps the public address and its copy button, because that is
  what a client calls. A `sent from server` tag beside it says the Send does not
  dial it from the browser: a working Try-me is no proof that the viewer's own
  address is on the list.
- Latency is measured at the api, around its call to the router. In **Compare
  both** both legs are measured from the same place.
- The code snippets still print the public address.

## Settings

| Variable | Default | |
|---|---|---|
| `ROUTER_RELAY_HOST` | `localhost` | where an SR_CONFIG mount's routers listen; unused for a helm mount |
| `ROUTER_RELAY_TIMEOUT_MS` | `30000` | deadline on the api→router call, body included |
| `ROUTER_RELAY_MAX_BODY_BYTES` | `4194304` | router answers past this come back `truncated: true` |
| `ROUTER_RELAY_RATE_LIMIT_MAX` | `60` | per signed-in user per minute; the relay and the ws probe each count their own |
