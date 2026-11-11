/**
 * "Via router", sent by the api — turn the SAME resolved request the drawer
 * would send from the browser into a payload for `POST /api/routers/relay`.
 *
 * Why: a deployment can admit only a list of source addresses at its public
 * hostnames, and a browser anywhere else is refused before the router sees
 * the request. So the api sends it instead, from inside the
 * deployment. The router is addressed by identity (router id + the interface
 * whose listener serves it), and the api works out where that listener is;
 * all the browser contributes is the path. Everything here is pure — the
 * drawer owns the fetch.
 */

import type { RouterRelayRequest } from "@sr/shared";
import type { ResolvedRequest } from "./build-request";
import { hasGraphQLErrors } from "./graphql-query";

/**
 * The path and query a resolved url puts on the router's listener: `/` for a
 * JSON-RPC POST, the call's own path for REST, `/ws` or `/websocket` for a
 * socket. The host is dropped — the api dials its own address for the router.
 */
export function routerPathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return "/";
  }
}

export type RouterRelayPayloadResult =
  | { ok: true; payload: RouterRelayRequest }
  | { ok: false; error: string };

export function routerRelayPayload(args: {
  routerId: string;
  /** The config interface whose listener serves this endpoint: the base one
   *  (`jsonrpc`), never its `-ws` variant — a socket rides the same listener. */
  iface: string;
  resolved: ResolvedRequest;
  /** Pin to this upstream with `lava-select-provider`. */
  selectUpstream?: string;
  /** Skip the router's cache with `lava-force-cache-refresh`. */
  skipCache: boolean;
}): RouterRelayPayloadResult {
  const { routerId, iface, resolved, selectUpstream, skipCache } = args;
  if (resolved.transport === "ws") {
    // No directives: the router reads none on a WebSocket, which is why the
    // drawer never offered them there.
    return {
      ok: true,
      payload: { routerId, iface, transport: "ws", path: routerPathOf(resolved.url), body: resolved.body },
    };
  }
  if (resolved.transport !== "http") {
    return { ok: false, error: "gRPC can't be sent through the relay." };
  }
  return {
    ok: true,
    payload: {
      routerId,
      iface,
      transport: "http",
      httpMethod: resolved.httpMethod,
      path: routerPathOf(resolved.url),
      ...(resolved.body !== null ? { body: resolved.body } : {}),
      ...(selectUpstream ? { selectProvider: selectUpstream } : {}),
      ...(skipCache ? { forceCacheRefresh: true } : {}),
    },
  };
}

/**
 * Whether a failed relay call is a result to show, not an error to raise: the
 * router never answering (504), and on a WebSocket the router refusing or
 * dropping the socket (502). A browser send reports both as results, and
 * "Compare both" still fires the upstream leg after one. An HTTP send that
 * cannot reach the router raises, as it does from the browser.
 */
export function routerFailureIsResult(statusCode: number, transport: "http" | "ws"): boolean {
  return statusCode === 504 || (statusCode === 502 && transport === "ws");
}

/**
 * Whether a router reply is an error, judged as the browser leg judged one: a
 * status outside 2xx, a JSON-RPC `error`, or GraphQL `errors`. A socket reply
 * has no status, so only its body counts.
 */
export function routerReplyErrored(reply: { httpStatus: number | null; body: unknown }): boolean {
  const { httpStatus, body } = reply;
  return (
    (httpStatus !== null && (httpStatus < 200 || httpStatus > 299)) ||
    (typeof body === "object" && body !== null && "error" in body) ||
    hasGraphQLErrors(body)
  );
}
