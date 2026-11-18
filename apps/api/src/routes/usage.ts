/**
 * Usage data (MAG-5373, MAG-5413). The browser sends to Mixpanel itself, and
 * only after the person at it accepts; the api never talks to Mixpanel.
 *
 *  - `GET /api/usage/config`: what the web starts Mixpanel's browser SDK
 *    with. `{ enabled: false }` unless accounts are on, the deployment's
 *    switch is on, it holds a token, and a signed-in user is on the request.
 *    Then `{ enabled: true, token, apiHost, tenant, deploymentMode, version,
 *    viewer }`, where `viewer` is `services/usage.ts`'s `UsageViewer`.
 *  - `GET /api/usage/viewers/:id`: admins only. The member of this deployment
 *    a usage id (Mixpanel's distinct id) belongs to, or `{ member: null }`.
 *    An admin already sees every member on the Team page; this only says
 *    which of them an id is.
 *
 * See docs/USAGE-DATA.md.
 */
import type { FastifyInstance } from "fastify";
import type { UsageSettings } from "../config.js";
import { requireRole } from "../plugins/auth.js";
import { findViewer, viewerOf } from "../services/usage.js";

export interface UsageRoutesOptions {
  settings: UsageSettings;
}

const USAGE_ID = /^[0-9a-f]{32}$/;

export async function usageRoutes(app: FastifyInstance, opts: UsageRoutesOptions) {
  const { settings } = opts;
  if (settings.problem) app.log.warn({ problem: settings.problem }, "usage data is off");

  app.get("/api/usage/config", { schema: { tags: ["usage"], summary: "Whether the dashboard records usage data, and what the browser starts it with" } }, async (request, reply) => {
    // An answer per signed-in user: never kept by a cache along the way.
    reply.header("Cache-Control", "no-store");
    // No signed-in user (an audit token, a gate that let the call through):
    // off, so no event is ever without its `staff` mark.
    const viewer = settings.enabled ? viewerOf(request.authUser, settings) : null;
    if (!viewer || !settings.token) return { enabled: false };
    return {
      enabled: true,
      token: settings.token,
      apiHost: settings.host,
      tenant: settings.tenant,
      deploymentMode: settings.deploymentMode,
      version: settings.version,
      viewer,
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/usage/viewers/:id",
    { schema: { tags: ["usage"], summary: "Admins: the member a usage id (Mixpanel's distinct id) belongs to" } },
    async (request, reply) => {
      if (!requireRole(request, reply, "admin")) return reply;
      reply.header("Cache-Control", "no-store");
      const id = request.params.id.toLowerCase();
      if (!USAGE_ID.test(id)) {
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "A usage id is 32 hex characters" });
      }
      if (!app.db) {
        return reply.code(503).send({ statusCode: 503, error: "Service Unavailable", message: "auth database not ready" });
      }
      return { member: await findViewer(app.db, settings.tenant, id) };
    },
  );
}
