/**
 * `POST /api/routers/relay` and `POST /api/routers/ws-probe` — the Try-me
 * drawer's "via router" leg, sent by the api.
 *
 * On in both auth modes, off with `ROUTER_RELAY_ENABLED=false`. Who may call
 * them is who may call the rest of `/api/*`: a signed-in user of any role with
 * accounts on, anyone who can reach the api with accounts off.
 *
 * The posture this sets, on purpose: a deployment that admits only a list of
 * source addresses at its public hostnames still lets every caller of this
 * api send requests through its routers, from anywhere. Where that is not
 * acceptable and there are no accounts, the switch turns the routes off and
 * the drawer sends from the browser.
 *
 * See `services/router-relay.ts` for what is sent and what comes back.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouterRelayRequest, RouterWsProbeRequest } from "@sr/shared";
import { config } from "../config.js";
import { requireAuth } from "../plugins/auth.js";
import { RelayTransportError } from "../services/upstream-relay.js";
import {
  buildRouterUrl,
  directiveHeaders,
  probeRouterWs,
  relayRouterHttp,
  relayRouterWs,
  RelaySlots,
} from "../services/router-relay.js";

export interface RouterRelayRoutesOptions {
  authMode: "enabled" | "disabled";
}

/** How long the probe waits for the upgrade — the drawer's own figure. */
const WS_PROBE_TIMEOUT_MS = 6000;

/** The drawer's ceiling on a WebSocket send from the browser. */
const WS_SEND_TIMEOUT_MS = 15000;

/** One caller's relays in flight: a drawer sends one at a time, so two is a
 *  second tab. */
const IN_FLIGHT_PER_CALLER = 2;

/** The deadline for one send: the configured one, and no longer on a
 *  WebSocket than the drawer waits for one from the browser. */
export function sendDeadlineMs(transport: "http" | "ws", configuredMs: number): number {
  return transport === "ws" ? Math.min(configuredMs, WS_SEND_TIMEOUT_MS) : configuredMs;
}

/** What a header value can carry: one byte per character, none of them a
 *  control. The HTTP client refuses anything else, and that would come back
 *  as a failure of our hop instead of a 400. */
const HEADER_SAFE = "^[\\u0020-\\u007e\\u0080-\\u00ff]+$";

const relayBodySchema = {
  type: "object",
  required: ["routerId", "iface"],
  additionalProperties: false,
  properties: {
    routerId: { type: "string", minLength: 1, maxLength: 128 },
    iface: { type: "string", minLength: 1, maxLength: 64 },
    transport: { type: "string", enum: ["http", "ws"], default: "http" },
    httpMethod: { type: "string", enum: ["GET", "POST"], default: "POST" },
    path: { type: "string", maxLength: 2048 },
    body: {},
    selectProvider: { type: "string", minLength: 1, maxLength: 256, pattern: HEADER_SAFE },
    forceCacheRefresh: { type: "boolean" },
  },
} as const;

const probeBodySchema = {
  type: "object",
  required: ["routerId", "iface"],
  additionalProperties: false,
  properties: {
    routerId: { type: "string", minLength: 1, maxLength: 128 },
    iface: { type: "string", minLength: 1, maxLength: 64 },
    path: { type: "string", maxLength: 256 },
  },
} as const;

/** Whose budget a request spends: the signed-in user's, wherever they sign in
 *  from (an office behind one address is several people); the address with
 *  accounts off, where there is nobody to name. */
function callerOf(request: FastifyRequest): string {
  return request.authUser?.id ?? request.ip;
}

const NO_LISTENER = "No such router listener in the mounted config.";
const DISABLED = "The router relay is off on this deployment (ROUTER_RELAY_ENABLED=false).";

/** gRPC listeners speak HTTP/2 only; neither leg here can dial one. */
function isGrpc(iface: string): boolean {
  return iface.toLowerCase().startsWith("grpc");
}

export async function routerRelayRoutes(app: FastifyInstance, opts: RouterRelayRoutesOptions) {
  const rateLimit = {
    max: config.routerRelay.rateLimitMax,
    timeWindow: "1 minute",
    keyGenerator: callerOf,
  };
  const slots = new RelaySlots(config.routerRelay.maxInFlight, IN_FLIGHT_PER_CALLER);

  /** False once the reply is sent: the relay is off, or accounts are on and
   *  nobody is signed in. The global gate already refuses the second case;
   *  this says so again in the handler, where a reader looks. */
  function admitted(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!config.routerRelay.enabled) {
      void reply.status(404).send({ message: DISABLED });
      return false;
    }
    return opts.authMode !== "enabled" || requireAuth(request, reply) !== null;
  }

  app.post<{ Body: RouterRelayRequest }>(
    "/api/routers/relay",
    {
      schema: {
        tags: ["Routers"],
        summary: "Send one request through a router, from inside the deployment",
        body: relayBodySchema,
      },
      config: { rateLimit },
    },
    async (request, reply) => {
      if (!admitted(request, reply)) return reply;

      const { routerId, iface, path, body } = request.body;
      const transport = request.body.transport ?? "http";
      const httpMethod = request.body.httpMethod ?? "POST";
      if (isGrpc(iface)) {
        return reply.status(400).send({ message: "The relay cannot dial gRPC listeners." });
      }

      const origin = app.routerConfig.resolveRouterOrigin(routerId, iface, transport);
      if (origin === null) return reply.status(404).send({ message: NO_LISTENER });
      const target = buildRouterUrl(origin, path);
      if (!target.ok) return reply.status(target.status).send({ message: target.error });

      const release = slots.take(callerOf(request));
      if (release === "caller") {
        return reply
          .status(429)
          .send({ message: `${IN_FLIGHT_PER_CALLER} requests of yours are still on their way through the relay.` });
      }
      if (release === "all") {
        return reply.status(503).send({ message: "The relay is busy. Try again in a moment." });
      }

      const limits = {
        timeoutMs: sendDeadlineMs(transport, config.routerRelay.timeoutMs),
        maxBodyBytes: config.routerRelay.maxBodyBytes,
      };
      try {
        const result =
          transport === "ws"
            ? await relayRouterWs(target.url, body, limits)
            : await relayRouterHttp(target.url, {
                httpMethod,
                body,
                headers: directiveHeaders(request.body),
                ...limits,
              });
        return reply.send(result);
      } catch (e) {
        if (e instanceof RelayTransportError) {
          // The router never answered — a failure of OUR hop, distinct from a
          // router that answered 4xx/5xx (which comes back 200 with its
          // status inside).
          return reply.status(e.kind === "timeout" ? 504 : 502).send({ message: e.message });
        }
        request.log.error({ err: e, routerId, iface }, "router relay failed");
        return reply.status(502).send({ message: "The relay could not complete the request." });
      } finally {
        release();
      }
    },
  );

  app.post<{ Body: RouterWsProbeRequest }>(
    "/api/routers/ws-probe",
    {
      schema: {
        tags: ["Routers"],
        summary: "Whether a router listener serves the WebSocket upgrade, seen from the api",
        body: probeBodySchema,
      },
      config: { rateLimit },
    },
    async (request, reply) => {
      if (!admitted(request, reply)) return reply;

      const { routerId, iface, path } = request.body;
      if (isGrpc(iface)) return reply.status(400).send({ message: "gRPC listeners serve no WebSocket." });
      const origin = app.routerConfig.resolveRouterOrigin(routerId, iface, "ws");
      if (origin === null) return reply.status(404).send({ message: NO_LISTENER });
      const target = buildRouterUrl(origin, path);
      if (!target.ok) return reply.status(target.status).send({ message: target.error });

      return reply.send({ online: await probeRouterWs(target.url, WS_PROBE_TIMEOUT_MS) });
    },
  );
}
