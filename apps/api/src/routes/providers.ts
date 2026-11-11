import type { FastifyInstance } from "fastify";
import { buildChainMetaByIndex, toCsv, toMetricWindow, WINDOWS } from "@sr/shared";
import { RANGE_QUERY_PROPERTIES, readRange, type RangeQuery } from "../services/read-range.js";
import { buildProviderReport } from "../services/provider-report.js";
import { sendApiError } from "../plugins/error-handler.js";

interface ReportQuery extends RangeQuery {
  provider?: string;
  spec?: string;
  router?: string;
  tz?: string;
}

const REPORT_SCHEMA = {
  type: "object" as const,
  required: ["provider", "spec"],
  properties: {
    ...RANGE_QUERY_PROPERTIES,
    provider: { type: "string" as const, pattern: "^[A-Za-z0-9 ._-]{1,64}$", description: "Provider company id from /api/metrics/providers" },
    spec: { type: "string" as const, pattern: "^[A-Za-z0-9_-]{1,64}$", description: "Chain spec label, e.g. XLM" },
    router: { type: "string" as const, description: "Restrict to ONE router deployment (optional)" },
    tz: { type: "string" as const, pattern: "^[A-Za-z0-9_+/-]{1,64}$", description: "IANA time zone for the report's times, e.g. Asia/Jerusalem (default UTC)" },
  },
};

const fileStem = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function providerRoutes(app: FastifyInstance) {
  // The provider report: text a customer pastes into a complaint to a provider.
  app.get<{ Querystring: ReportQuery }>("/api/providers/report", {
    schema: {
      tags: ["Providers"],
      summary: "A complaint to one provider about one chain over a range: counts from metrics, times and example requests from the router's logs",
      querystring: REPORT_SCHEMA,
    },
  }, async (request, reply) => {
    const range = readRange(request.query);
    if ("error" in range) {
      sendApiError(reply, 400, range.error);
      return reply;
    }
    const report = await buildProviderReport(
      { providers: app.scoped(request.query.router).providers, errorRequests: app.errorRequests, config: app.routerConfig },
      { providerId: String(request.query.provider), spec: String(request.query.spec), range, tz: request.query.tz },
    );
    if (!report) {
      sendApiError(reply, 404, "That provider has no traffic on that chain");
      return reply;
    }
    return report;
  });

  app.get<{ Querystring: ReportQuery }>("/api/providers/report.csv", {
    schema: { tags: ["Providers"], summary: "The provider report as CSV (field, value)", querystring: REPORT_SCHEMA },
  }, async (request, reply) => {
    const range = readRange(request.query);
    if ("error" in range) {
      sendApiError(reply, 400, range.error);
      return reply;
    }
    const report = await buildProviderReport(
      { providers: app.scoped(request.query.router).providers, errorRequests: app.errorRequests, config: app.routerConfig },
      { providerId: String(request.query.provider), spec: String(request.query.spec), range, tz: request.query.tz },
    );
    if (!report) {
      sendApiError(reply, 404, "That provider has no traffic on that chain");
      return reply;
    }
    const rows = report.text.split("\n").map((line) => {
      const i = line.indexOf(": ");
      return i > 0 && !line.startsWith("- ") ? [line.slice(0, i), line.slice(i + 2)] : ["", line];
    });
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="report-${fileStem(report.provider.name)}-${fileStem(report.spec)}.csv"`)
      .send(toCsv(["field", "value"], rows));
  });

  // Every provider × chain for the window - the providers list as a file.
  app.get<{ Querystring: { window?: string; router?: string } }>("/api/providers/export.csv", {
    schema: {
      tags: ["Providers"],
      summary: "Every provider × chain for the window as CSV",
      querystring: {
        type: "object" as const,
        properties: {
          window: RANGE_QUERY_PROPERTIES.window,
          router: { type: "string" as const, description: "Restrict to ONE router deployment (optional)" },
        },
      },
    },
  }, async (request, reply) => {
    const window = toMetricWindow(request.query.window);
    const providers = await app.scoped(request.query.router).providers.withChains(window);
    const end = Date.now();
    const start = end - WINDOWS[window].rangeSeconds * 1000;
    const rows: (string | null)[][] = [];
    const n = (v: number | null) => (v == null ? "" : String(v));
    const p = (v: number | null) => (v == null ? "" : (v * 100).toFixed(2));
    for (const { provider, chains } of providers) {
      for (const c of chains) {
        rows.push([
          provider.name,
          c.account ?? "",
          buildChainMetaByIndex(c.spec).name,
          c.spec,
          c.role ?? "",
          n(c.requests),
          c.errorRate == null ? "" : String(Math.round(c.requests * c.errorRate)),
          p(c.errorRate),
          p(c.nodeErrorRate),
          p(c.protocolErrorRate),
          c.p95Ms == null ? "" : String(Math.round(c.p95Ms)),
          n(c.rateLimitHits),
          p(c.uptime),
          n(c.downMinutes),
          new Date(start).toISOString(),
          new Date(end).toISOString(),
        ]);
      }
    }
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="providers-${window}.csv"`)
      .send(
        toCsv(
          ["provider", "account", "chain", "spec", "role", "requests", "failed_requests", "error_pct", "error_reply_pct", "timeout_and_connection_error_pct", "p95_ms", "rate_limit_hits", "uptime_pct", "down_minutes", "window_start", "window_end"],
          rows,
        ),
      );
  });
}
