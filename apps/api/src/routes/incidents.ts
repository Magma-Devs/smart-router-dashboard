/**
 * `POST /api/incidents` — a member tells Magma's engineers that something is
 * wrong, with a severity, and the report goes to our on-call system.
 *
 * Off unless `INCIDENTS_ENABLED=true` (see `readIncidentSettings`). Registered in
 * both auth modes, and the mode decides who the reporter is:
 *
 *  - `AUTH_MODE=disabled` — anyone who can reach the api may report. Name and
 *    email are required in the body and recorded as typed, marked unverified.
 *  - `AUTH_MODE=enabled` — the global gate has already required a session; the
 *    reporter is the signed-in user, any role, and a reporter in the body is
 *    ignored. The report is audited as `incident.reported`.
 *
 * See `services/incidents.ts` for what is sent and `docs/INCIDENTS.md` for the
 * whole path.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  INCIDENT_LIMITS,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABELS,
  looksLikeEmail,
  type IncidentReportRequest,
  type IncidentReportResponse,
} from "@sr/shared";
import { config, type IncidentSettings } from "../config.js";
import { requireAuth } from "../plugins/auth.js";
import { sendApiError } from "../plugins/error-handler.js";
import { lazyAuditWriter } from "../services/audit.js";
import { normalizeIp } from "../services/client-context.js";
import { resolveClientContext } from "./auth.js";
import {
  buildIrmPayload,
  cleanIncidentText,
  cleanIncidentTitle,
  ReportBudget,
  sendToIrm,
  type IncidentReporterContext,
} from "../services/incidents.js";

export interface IncidentRoutesOptions {
  authMode: "enabled" | "disabled";
  settings: IncidentSettings;
  /** Injected by tests; the global `fetch` otherwise. */
  fetchImpl?: typeof fetch;
}

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
/** A spec index or a router id: the characters both are made of, nothing a
 *  template could read as markup. */
const IDENT = "^[A-Za-z0-9][A-Za-z0-9_.:-]*$";

const POD_WINDOW_MS = 5 * 60_000;

/** Send the error and hand back the reply, which is what tells Fastify the
 *  handler is done — returning the error body as well makes it send twice. */
function refuse(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  sendApiError(reply, statusCode, message);
  return reply;
}

function bodySchema(authMode: IncidentRoutesOptions["authMode"]) {
  return {
    type: "object",
    required: authMode === "enabled" ? ["id", "severity", "title"] : ["id", "severity", "title", "reporter"],
    additionalProperties: false,
    properties: {
      id: { type: "string", pattern: UUID },
      severity: { type: "string", enum: [...INCIDENT_SEVERITIES] },
      title: { type: "string", minLength: 1, maxLength: INCIDENT_LIMITS.title },
      description: { type: ["string", "null"], maxLength: INCIDENT_LIMITS.description },
      chain: { type: ["string", "null"], maxLength: 64, pattern: IDENT },
      routerId: { type: ["string", "null"], maxLength: 128, pattern: IDENT },
      reporter: {
        type: authMode === "enabled" ? ["object", "null"] : "object",
        required: ["name", "email"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: INCIDENT_LIMITS.name },
          email: { type: "string", minLength: 3, maxLength: INCIDENT_LIMITS.email },
          phone: { type: ["string", "null"], maxLength: INCIDENT_LIMITS.phone },
        },
      },
    },
  } as const;
}

/**
 * Whose report this is, for the per-caller limit.
 *
 * Not `request.ip`: behind the fleet's gateway that is an in-cluster hop shared
 * by everybody arriving through the same node, so one caller could spend the
 * whole node's allowance and lock the customer out of reporting. Cloudflare
 * fronts the fleet and sets `cf-connecting-ip` itself. A deployment without it
 * in front lets a caller choose that header — which buys them a fresh
 * allowance, as a new address would, and no more: the per-process budget below
 * still bounds them.
 */
function callerKey(request: FastifyRequest): string {
  const header = request.headers["cf-connecting-ip"];
  return normalizeIp(typeof header === "string" ? header : null) ?? request.ip;
}

export async function incidentRoutes(app: FastifyInstance, opts: IncidentRoutesOptions) {
  const { authMode, settings } = opts;
  const budget = new ReportBudget(settings.podMax, POD_WINDOW_MS);
  const audit = lazyAuditWriter(app);

  if (settings.enabled && settings.problem) {
    // Loud at boot, because every report from now on will be refused and the
    // only other trace is the person who tried.
    app.log.error({ problem: settings.problem }, "incident reporting is on but cannot send — every report will answer 503");
  }

  app.post<{ Body: IncidentReportRequest }>(
    "/api/incidents",
    {
      schema: {
        tags: ["Incidents"],
        summary: "Report an incident to Magma's engineers, with a severity",
        body: bodySchema(authMode),
      },
      config: {
        rateLimit: { max: settings.perIpMax, timeWindow: "10 minutes", keyGenerator: callerKey },
      },
    },
    async (request, reply) => {
      if (!settings.enabled) {
        return refuse(reply, 404, "Incident reporting is off on this deployment.");
      }

      let reporter: IncidentReporterContext;
      let sessionId: string | null = null;
      let actorId: string | null = null;
      if (authMode === "enabled") {
        const me = requireAuth(request, reply);
        if (!me) return reply;
        reporter = { name: me.user.name?.trim() || me.email, email: me.email, phone: null, signedIn: true, role: me.role };
        sessionId = me.sessionId;
        actorId = me.id;
      } else {
        // Required by the schema in this mode, so present.
        const typed = request.body.reporter!;
        const name = cleanIncidentTitle(typed.name);
        const email = typed.email.trim();
        const phone = typed.phone ? cleanIncidentTitle(typed.phone) : "";
        if (name === "") return refuse(reply, 400, "Your name is required.");
        if (!looksLikeEmail(email)) return refuse(reply, 400, "That email address doesn't look complete.");
        reporter = { name, email, phone: phone || null, signedIn: false, role: null };
      }

      const title = cleanIncidentTitle(request.body.title);
      if (title === "") return refuse(reply, 400, "A title is required.");
      const description = request.body.description ? cleanIncidentText(request.body.description) || null : null;

      // A chain or router the mounted values file doesn't declare is refused
      // rather than forwarded: the on-call would go looking for something this
      // deployment does not run. With no values file there is nothing to check
      // against, so neither is sent.
      const routers = app.routerConfig.getRouters();
      let chain = request.body.chain ?? null;
      let routerId = request.body.routerId ?? null;
      if (routers.length === 0) {
        chain = null;
        routerId = null;
      } else {
        if (chain !== null && !routers.some((r) => r.spec === chain)) {
          return refuse(reply, 400, `This deployment does not serve the chain ${chain}.`);
        }
        if (routerId !== null && !routers.some((r) => r.id === routerId)) {
          return refuse(reply, 400, `This deployment has no router ${routerId}.`);
        }
      }

      if (!settings.webhookUrl) {
        return refuse(reply, 503, "Incident reporting is not set up on this deployment yet.");
      }
      if (!budget.take()) {
        return refuse(
          reply,
          429,
          "Too many incident reports have come from this dashboard in the last few minutes. Please use the contact below.",
        );
      }

      const receivedAt = new Date();
      const ctx = {
        id: request.body.id.toLowerCase(),
        severity: request.body.severity,
        title,
        description,
        chain,
        routerId,
        reporter,
        dashboardVersion: config.build.version,
        receivedAt,
      };
      const delivery = await sendToIrm(settings.webhookUrl, buildIrmPayload(ctx), settings.timeoutMs, opts.fetchImpl);
      const logged = { incidentId: ctx.id, severity: ctx.severity, signedIn: reporter.signedIn };
      if (!delivery.ok) {
        request.log.warn({ ...logged, status: delivery.status, reason: delivery.reason }, "incident report not accepted by the on-call system");
        return refuse(reply, 502, "Our on-call system did not accept the report. Please try again, or use the contact below.");
      }
      request.log.info(logged, "incident report accepted by the on-call system");

      if (authMode === "enabled" && actorId) {
        const { access } = resolveClientContext(request, undefined);
        await audit.write({
          action: "incident.reported",
          actor: { id: actorId, kind: "user" },
          target: { type: "incident", id: ctx.id, name: title },
          access: { ...access, sessionId },
          note: INCIDENT_SEVERITY_LABELS[ctx.severity],
        });
      }

      const body: IncidentReportResponse = { id: ctx.id, severity: ctx.severity, sentAt: receivedAt.toISOString() };
      return body;
    },
  );
}
