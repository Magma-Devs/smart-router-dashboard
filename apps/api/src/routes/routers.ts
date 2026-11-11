/**
 * `POST /api/routers/relay` and `POST /api/routers/ws-probe` — the Try-me
 * drawer's "via router" leg, sent by the api.
 *
 * Registered only when AUTH_MODE=enabled, so the global gate already refuses
 * anyone without a live session; `requireAuth` below says so again in the
 * handler, where a reader looks. Any signed-in role may use them: Try-me is
 * open to every viewer of the dashboard.
 *
 * The posture this sets, on purpose: a tenant that admits only a list of
 * source addresses at its edge still lets every signed-in dashboard user send
 * requests through its routers, from anywhere. Without sign-in the dashboard
 * api answers anonymously, and these routes would be a way round the list for
 * anyone on the internet — which is why they do not exist in that mode.
 *
 * See `services/router-relay.ts` for what is sent and what comes back.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RouterRelayRequest, RouterWsProbeRequest } from "@sr/shared";
import { config } from "../config.js";
import { requireAuth } from "../plugins/auth.js";
import { buildTargetUrl, RelayTransportError } from "../services/upstream-relay.js";
import {
  directiveHeaders,
  probeRouterWs,
  relayRouterHttp,
  relayRouterWs,
} from "../services/router-relay.js";

/** How long the probe waits for the upgrade — the drawer's own figure. */
const WS_PROBE_TIMEOUT_MS = 6000;

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

/** One person's budget, wherever they sign in from — an office behind one
 *  address is several people. Falls back to the address for a request the
 *  gate let through without a session, which none of these should be. */
function perUser(request: FastifyRequest): string {
  return request.authUser?.id ?? request.ip;
}

const NO_LISTENER = "No such router listener in the mounted config.";

/** gRPC listeners speak HTTP/2 only; neither leg here can dial one. */
function isGrpc(iface: string): boolean {
  return iface.toLowerCase().startsWith("grpc");
}

export async function routerRelayRoutes(app: FastifyInstance) {
  const rateLimit = {
    max: config.routerRelay.rateLimitMax,
    timeWindow: "1 minute",
    keyGenerator: perUser,
  };

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
      if (!requireAuth(request, reply)) return reply;

      const { routerId, iface, path, body } = request.body;
      const transport = request.body.transport ?? "http";
      const httpMethod = request.body.httpMethod ?? "POST";
      if (isGrpc(iface)) {
        return reply.status(400).send({ message: "The relay cannot dial gRPC listeners." });
      }

      const origin = app.routerConfig.resolveRouterOrigin(routerId, iface, transport);
      if (origin === null) return reply.status(404).send({ message: NO_LISTENER });
      const target = buildTargetUrl(origin, path);
      if (!target.ok) return reply.status(400).send({ message: target.error });

      const limits = {
        timeoutMs: config.routerRelay.timeoutMs,
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
      if (!requireAuth(request, reply)) return reply;

      const { routerId, iface, path } = request.body;
      if (isGrpc(iface)) return reply.status(400).send({ message: "gRPC listeners serve no WebSocket." });
      const origin = app.routerConfig.resolveRouterOrigin(routerId, iface, "ws");
      if (origin === null) return reply.status(404).send({ message: NO_LISTENER });
      const target = buildTargetUrl(origin, path);
      if (!target.ok) return reply.status(400).send({ message: target.error });

      return reply.send({ online: await probeRouterWs(target.url, WS_PROBE_TIMEOUT_MS) });
    },
  );
}
