/**
 * Usage data (MAG-5373): `GET /api/usage/config`, what the web starts
 * Mixpanel's browser SDK with. The browser sends to Mixpanel itself, and only
 * after the person at it accepts; the api never talks to Mixpanel.
 *
 *  - `{ enabled: false }` unless accounts are on, the deployment's switch is
 *    on, it holds a token, and a signed-in user is on the request.
 *  - Then `{ enabled: true, token, apiHost, tenant, deploymentMode, version,
 *    viewer: { id, staff, role } }`, where `viewer.id` is opaque
 *    (`services/usage.ts`).
 *
 * See docs/USAGE-DATA.md.
 */
import type { FastifyInstance } from "fastify";
import type { UsageSettings } from "../config.js";
import { viewerOf } from "../services/usage.js";

export interface UsageRoutesOptions {
  settings: UsageSettings;
}

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
}
