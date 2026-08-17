/**
 * `POST /api/upstreams/relay` — fire a request at ONE configured upstream,
 * bypassing the router, and hand back what it answered.
 *
 * The Try-me drawer's "Direct to upstream" mode is the only caller. It exists
 * because pinning a relay with `lava-select-provider` still measures the
 * router's path (its cache, its retries, its hedging); to see what an upstream
 * does on its own you have to leave the router out, and only the api can —
 * the browser never holds the credentialed url. See
 * `services/upstream-relay.ts` for the rules that keep this from being an
 * open proxy.
 */

import type { FastifyInstance } from "fastify";
import type { UpstreamRelayRequest } from "@sr/shared";
import { config } from "../config.js";
import {
  buildTargetUrl,
  relayHttp,
  relayWs,
  RelayTransportError,
} from "../services/upstream-relay.js";

const relayBodySchema = {
  type: "object",
  required: ["routerId", "node", "endpointIndex"],
  additionalProperties: false,
  properties: {
    routerId: { type: "string", minLength: 1, maxLength: 128 },
    node: { type: "string", minLength: 1, maxLength: 128 },
    endpointIndex: { type: "integer", minimum: 0, maximum: 255 },
    httpMethod: { type: "string", enum: ["GET", "POST"], default: "POST" },
    transport: { type: "string", enum: ["http", "ws"], default: "http" },
    path: { type: "string", maxLength: 2048 },
    body: {},
  },
} as const;

export async function upstreamRoutes(app: FastifyInstance) {
  app.post<{ Body: UpstreamRelayRequest }>(
    "/api/upstreams/relay",
    {
      schema: {
        tags: ["Upstreams"],
        summary: "Relay one request straight to a configured upstream (no router)",
        body: relayBodySchema,
      },
      // Tighter than the global RATE_LIMIT_MAX: every call here spends the
      // operator's upstream quota, not ours.
      config: { rateLimit: { max: config.upstreamRelay.rateLimitMax, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!config.upstreamRelay.enabled) {
        return reply.status(404).send({
          message: "Direct upstream relay is disabled on this deployment (UPSTREAM_RELAY_ENABLED=false).",
        });
      }

      const { routerId, node, endpointIndex, path, body } = request.body;
      const httpMethod = request.body.httpMethod ?? "POST";
      const transport = request.body.transport ?? "http";

      const dial = app.routerConfig.resolveEndpoint({ routerId, node, endpointIndex });
      if (dial === null) {
        // Deliberately identical for "no such router", "no such node" and "no
        // such endpoint" — the caller learns nothing about the config it
        // didn't already have from GET /api/config/routers.
        return reply.status(404).send({ message: "No such upstream endpoint in the mounted config." });
      }
      if (dial.unresolved.length > 0) {
        // The values file NAMES this endpoint's credential but doesn't carry
        // it (an envsubst placeholder the router resolves from its own
        // environment, or a Kubernetes Secret). Dialing anyway would send a
        // literal `${VAR}` and report the upstream's 401 as the upstream's
        // verdict on the request — say what is actually missing instead.
        return reply.status(422).send({
          message: `This upstream's credential isn't in the mounted values file (${dial.unresolved.join(", ")}) — the router reads it from its own environment. Send this one through the router instead.`,
        });
      }

      let scheme: string;
      try {
        scheme = new URL(dial.url).protocol;
      } catch {
        return reply.status(400).send({ message: "That upstream's url in the values file is malformed." });
      }
      const isWsUrl = scheme === "ws:" || scheme === "wss:";
      if ((transport === "ws") !== isWsUrl) {
        return reply.status(400).send({
          message: isWsUrl
            ? "That upstream endpoint is a WebSocket url — send it with transport 'ws'."
            : "That upstream endpoint is an HTTP url — send it with transport 'http'.",
        });
      }
      if (!isWsUrl && scheme !== "http:" && scheme !== "https:") {
        return reply.status(400).send({
          message: `The relay cannot dial ${scheme.replace(":", "")} upstreams.`,
        });
      }

      const target = buildTargetUrl(dial.url, path, dial.authQuery);
      if (!target.ok) return reply.status(400).send({ message: target.error });

      try {
        const result =
          transport === "ws"
            ? await relayWs(target.url, body, {
                timeoutMs: config.upstreamRelay.timeoutMs,
                maxBodyBytes: config.upstreamRelay.maxBodyBytes,
                authHeaders: dial.authHeaders,
              })
            : await relayHttp(target.url, {
                httpMethod,
                body,
                timeoutMs: config.upstreamRelay.timeoutMs,
                maxBodyBytes: config.upstreamRelay.maxBodyBytes,
                authHeaders: dial.authHeaders,
              });
        return reply.send(result);
      } catch (e) {
        if (e instanceof RelayTransportError) {
          // The upstream never answered — that is a gateway-class failure of
          // OUR hop, distinct from an upstream that answered 4xx/5xx (which
          // comes back 200 with its own status inside).
          return reply.status(e.kind === "timeout" ? 504 : 502).send({ message: e.message });
        }
        // Log without the url: it carries the operator's key.
        request.log.error({ err: e, routerId, node, endpointIndex }, "upstream relay failed");
        return reply.status(502).send({ message: "The relay could not complete the request." });
      }
    },
  );
}
