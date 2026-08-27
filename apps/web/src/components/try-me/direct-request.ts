/**
 * "Direct to upstream" mode — turn the SAME resolved request the drawer would
 * send through the router into a payload for `POST /api/upstreams/relay`.
 *
 * The browser never holds an upstream url (the api masks node urls to
 * scheme+host, because that is where API keys live), so a direct call is
 * addressed by the endpoint's identity in the mounted values file and dialed
 * server-side. Everything here is pure — the drawer owns the fetch.
 */

import type { UpstreamRelayRequest } from "@sr/shared";
import type { CatalogInterface } from "./chain-methods";
import type { ResolvedRequest } from "./build-request";

/**
 * The upstream endpoints behind ONE Upstreams-page row: a node serves the
 * same chain over an http url and (sometimes) a ws url, which are separate
 * entries in the values file, so the drawer's HTTP/WS toggle has to switch
 * targets as well as envelopes.
 */
export interface DirectTarget {
  routerId: string;
  /** Node name in the values file (`eth-publicnode`). */
  node: string;
  /** Index of this node's http(s) endpoint, or null when it has none. */
  httpIndex: number | null;
  /** Index of this node's ws(s) endpoint, or null when it has none. */
  wsIndex: number | null;
  /** Masked `scheme://host` of each, for display only — never dialable. */
  httpHost: string | null;
  wsHost: string | null;
  /** `internal-path` each endpoint is pinned to in the values file, or null
   *  when it serves the root. See `resolveDirectPath`. */
  httpInternalPath?: string | null;
  wsInternalPath?: string | null;
}

/**
 * Where an internal-path method lands on ONE upstream url.
 *
 * The router keeps a proxy per internal path and builds its url two ways
 * (smart-router `protocol/chainlib/chain_router.go`):
 *
 *   node-url pinned to `/v2`   → that url IS the /v2 root, used as it stands
 *   node-url with no path      → `nodeUrl.Url = baseUrl + internalPath`
 *                                (`autoGenerateMissingInternalPaths`)
 *
 * The direct leg addresses one of those urls by hand, so it has to do the
 * same arithmetic: prefix the internal path when the upstream is the shared
 * root, leave it off when the upstream is already that version's root. Sending
 * `/v2/getMasterchainInfo` at a url pinned to /v2 asks tatum for
 * `…/v2/v2/getMasterchainInfo`.
 *
 * A method from a DIFFERENT internal path than the endpoint's is refused: a
 * url pinned to /v2 does not serve /v3, whatever path we prepend.
 */
export type DirectPathResult =
  | { ok: true; prefix: string }
  | { ok: false; error: string };

export function resolveDirectPath(args: {
  /** Internal path of the catalog command, if it has one. */
  methodPath: string | null | undefined;
  /** Internal path the upstream endpoint is pinned to, if any. */
  endpointPath: string | null | undefined;
}): DirectPathResult {
  const method = args.methodPath ?? "";
  const endpoint = args.endpointPath ?? "";
  if (endpoint === "") return { ok: true, prefix: method };
  if (method === "" || method === endpoint) return { ok: true, prefix: "" };
  return {
    ok: false,
    error: `This upstream is pinned to ${endpoint} in the values file, and this method is served under ${method}. Pick an upstream on ${method}, or send it through the router.`,
  };
}

export type RelayPayloadResult =
  | { ok: true; payload: UpstreamRelayRequest }
  | { ok: false; error: string };

export function relayPayloadFor(args: {
  resolved: ResolvedRequest;
  /** Raw params textarea — for REST it IS the path, which the relay appends
   *  to the upstream's own path rather than replacing it. */
  paramsText: string;
  iface: CatalogInterface;
  target: DirectTarget;
  /** Internal path of the selected command, when the spec serves it under
   *  one. `resolveDirectPath` turns it into the prefix this upstream needs. */
  methodInternalPath?: string | null;
}): RelayPayloadResult {
  const { resolved, paramsText, iface, target, methodInternalPath } = args;

  if (resolved.transport === "ws") {
    if (target.wsIndex === null) {
      return { ok: false, error: "This upstream has no WebSocket url in the values file." };
    }
    const wsPath = resolveDirectPath({
      methodPath: methodInternalPath,
      endpointPath: target.wsInternalPath,
    });
    if (!wsPath.ok) return { ok: false, error: wsPath.error };
    return {
      ok: true,
      payload: {
        routerId: target.routerId,
        node: target.node,
        endpointIndex: target.wsIndex,
        transport: "ws",
        httpMethod: "POST",
        body: resolved.body,
        // A ws url is dialed as it stands; the internal path can only make it
        // wrong. It is still resolved above so a /v3 method aimed at a
        // /v2-pinned socket is refused rather than silently sent.
      },
    };
  }

  if (resolved.transport !== "http") {
    return { ok: false, error: "The relay can't dial gRPC upstreams." };
  }
  if (target.httpIndex === null) {
    return { ok: false, error: "This upstream has no HTTP url in the values file." };
  }
  const resolvedPath = resolveDirectPath({
    methodPath: methodInternalPath,
    endpointPath: target.httpInternalPath,
  });
  if (!resolvedPath.ok) return { ok: false, error: resolvedPath.error };
  // REST carries its arguments in the path, so the prefix goes in front of
  // what the textarea holds. Everything else carries them in the body, and
  // the prefix IS the whole path — an unpinned AVAX url needs `/P` appended
  // before `platform.*` can be answered.
  const path =
    iface === "rest" ? `${resolvedPath.prefix}${paramsText.trim()}` : resolvedPath.prefix;
  return {
    ok: true,
    payload: {
      routerId: target.routerId,
      node: target.node,
      endpointIndex: target.httpIndex,
      transport: "http",
      httpMethod: resolved.httpMethod,
      ...(path ? { path } : {}),
      ...(resolved.body !== null ? { body: resolved.body } : {}),
    },
  };
}

/** Whether a direct call is possible for the transport currently selected. */
export function directAvailableFor(target: DirectTarget | null, onWs: boolean): boolean {
  if (target === null) return false;
  return onWs ? target.wsIndex !== null : target.httpIndex !== null;
}
