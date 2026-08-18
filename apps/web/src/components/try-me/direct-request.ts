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
}): RelayPayloadResult {
  const { resolved, paramsText, iface, target } = args;

  if (resolved.transport === "ws") {
    if (target.wsIndex === null) {
      return { ok: false, error: "This upstream has no WebSocket url in the values file." };
    }
    return {
      ok: true,
      payload: {
        routerId: target.routerId,
        node: target.node,
        endpointIndex: target.wsIndex,
        transport: "ws",
        httpMethod: "POST",
        body: resolved.body,
      },
    };
  }

  if (resolved.transport !== "http") {
    return { ok: false, error: "The relay can't dial gRPC upstreams." };
  }
  if (target.httpIndex === null) {
    return { ok: false, error: "This upstream has no HTTP url in the values file." };
  }
  const path = iface === "rest" ? paramsText.trim() : "";
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
