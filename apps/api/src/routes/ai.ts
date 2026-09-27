/**
 * AI routes (MAG-3702). Two, with one job each:
 *
 *   GET  /api/ai/health   free, instant — is AI configured and allowed?
 *   POST /api/ai/verify   costs ~30 tokens — does the model actually answer?
 *
 * The split matters. Flags are cheap enough for a monitor to poll; proving the
 * identity can invoke the model needs a real call, because a role can hold a
 * valid session and still be denied `bedrock:InvokeModel`.
 *
 * `/api/ai/*` sits under the same auth gate as the rest of `/api/*`, so with
 * `AUTH_MODE=enabled` the caller is already identified. With
 * `AUTH_MODE=disabled` there is no gate — which is why `bedrockGate()` refuses
 * in that mode rather than trusting a gate that was never installed.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { BedrockError, BedrockService, bedrockGate } from "../services/bedrock.js";
import { StatusAiService } from "../services/status-ai.js";
import { IncidentsService } from "../services/incidents.js";
import { FailureAnalysisService } from "../services/failure-analysis.js";
import { IncidentExplainService } from "../services/incident-explain.js";
import { ChainAnalysisService } from "../services/chain-analysis.js";
import { FormulatedIssueService, severityOf } from "../services/formulated-issues.js";
import { outcomesBySpec } from "../services/issues-feed.js";
import { LokiService, groupErrors } from "../services/loki.js";
import { OPTIONAL_METRICS } from "@sr/shared";
import { parseWindow } from "./metrics.js";

/** Which model this deployment would call. Nothing here is secret — no credential exists to leak. */
function target() {
  return {
    provider: "bedrock",
    auth: "sigv4",
    model: config.bedrock.model,
    region: config.bedrock.region,
    // An ARN names a role; it is not a secret. `null` = the chain's own identity.
    roleArn: config.bedrock.roleArn ?? null,
  };
}

/** Read the live env, as the auth plugin does, so the two cannot disagree. */
function gate() {
  return bedrockGate(process.env.AUTH_MODE ?? config.auth.mode);
}

export async function aiRoutes(app: FastifyInstance) {
  app.get(
    "/api/ai/health",
    {
      schema: {
        tags: ["AI"],
        summary: "Is a model configured and allowed to be called?",
        description:
          "Free and instant — no model call, and deliberately no credential resolution " +
          "either, which blocks for seconds on IMDS when there are none. `reason` is " +
          "`disabled` (BEDROCK_ENABLED unset) or `auth_required` (enabled but " +
          "AUTH_MODE=disabled, so it must not be spendable anonymously). " +
          "Use POST /api/ai/verify to prove the model actually answers.",
      },
    },
    async () => ({ ...gate(), ...target() }),
  );

  app.post(
    "/api/ai/verify",
    {
      // Tighter than the global limit: this one reaches an external service,
      // and a signed-in caller looping it is the failure auth does not prevent.
      config: { rateLimit: { max: config.bedrock.rateLimitMax, timeWindow: "1 minute" } },
      schema: {
        tags: ["AI"],
        summary: "Send one tiny prompt to the model and report what came back",
        description:
          "Makes one real model call. The deployment check: credentials " +
          "resolving is not the same as being allowed to invoke this model, and only a " +
          "real call tells them apart. Run it once after wiring a new server.",
      },
    },
    async (_request, reply) => {
      const g = gate();
      if (!g.ok) {
        // Checked BEFORE the call, so a shut gate spends nothing. 503: the
        // dashboard is up, the thing it would call is not reachable from here.
        reply.status(503);
        return { ...g, ...target() };
      }

      const startedAt = Date.now();
      try {
        const answer = await new BedrockService(config.bedrock.model, app.log).complete({
          // Fixed and trivial on purpose: this measures the round trip, not the
          // model, and every run should cost the same.
          messages: [{ role: "user", content: "Reply with exactly: SMART_ROUTER_BEDROCK_OK" }],
          maxTokens: 32,
        });
        return {
          ok: true,
          ...target(),
          answer: answer.text,
          latencyMs: Date.now() - startedAt,
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
        };
      } catch (err) {
        reply.status(502);
        return {
          ok: false,
          reason: "model_call_failed",
          // AWS's own name for it — AccessDenied, Throttling and an unreachable
          // endpoint need three different fixes, and collapsing them wastes the call.
          awsErrorName: err instanceof BedrockError ? err.awsErrorName : null,
          detail: err instanceof Error ? err.message : String(err),
          ...target(),
        };
      }
    },
  );

  app.post<{ Querystring: { window?: string; router?: string } }>(
    "/api/ai/status-analysis",
    {
      config: { rateLimit: { max: config.bedrock.rateLimitMax, timeWindow: "1 minute" } },
      schema: {
        tags: ["AI"],
        summary: "Relate the Status page's findings to each other",
        description:
          "Reads the whole Status report plus 24h of incidents and returns " +
          "correlated themes — the join the page cannot make, since one provider can appear " +
          "as an Issue, an Insight and the blamed party in an Incident with nothing linking " +
          "them. Every theme cites the finding ids it rests on; any that cites nothing real " +
          "is dropped server-side before it renders, and `droppedUncited` counts them.",
      },
    },
    async (request, reply) => {
      const g = gate();
      if (!g.ok) {
        reply.status(503);
        return { ...g, ...target() };
      }

      const scoped = app.scoped(request.query.router);
      // Both reads happen regardless of the model — a brief over a half-read
      // report would be worse than no brief.
      const [report, incidentsReport] = await Promise.all([
        scoped.metricsDetail.status(parseWindow(request.query.window)),
        new IncidentsService(app.prom, app.routerConfig).incidents(24),
      ]);

      const startedAt = Date.now();
      try {
        const svc = new StatusAiService(
          new BedrockService(config.bedrock.model, app.log),
          app.log,
        );
        const analysis = await svc.analyse(report, incidentsReport.incidents);
        return {
          ok: true,
          ...target(),
          ...analysis,
          model: config.bedrock.model,
          latencyMs: Date.now() - startedAt,
          // What it read, so a thin brief is explicable rather than suspicious.
          input: {
            findings: report.findings.length,
            insights: report.insights.length,
            incidents: incidentsReport.incidents.length,
          },
        };
      } catch (err) {
        reply.status(502);
        return {
          ok: false,
          reason: "model_call_failed",
          awsErrorName: err instanceof BedrockError ? err.awsErrorName : null,
          detail: err instanceof Error ? err.message : String(err),
          ...target(),
        };
      }
    },
  );

  app.post<{ Querystring: { spec?: string; upstream?: string; window?: string; router?: string } }>(
    "/api/ai/failure-analysis",
    {
      config: { rateLimit: { max: config.bedrock.rateLimitMax, timeWindow: "1 minute" } },
      schema: {
        tags: ["AI"],
        summary: "Why one provider is failing on one chain, and whose problem it is",
        description:
          "Takes `spec` and `upstream`. Reads the findings naming that pair, the real error " +
          "lines from the logs, the chain's OTHER providers over the same window, and the " +
          "same provider's other chains — then returns a verdict in the page's own " +
          "vocabulary: provider, setup, caller, chain, or undetermined. The peers are the " +
          "decisive input: one provider failing while its peers are clean is the provider's " +
          "problem; every provider failing identically is the chain's or the caller's.",
      },
    },
    async (request, reply) => {
      const { spec, upstream } = request.query;
      if (!spec || !upstream) {
        reply.status(400);
        return { error: "spec and upstream are both required" };
      }

      const g = gate();
      if (!g.ok) {
        reply.status(503);
        return { ...g, ...target() };
      }

      const window = parseWindow(request.query.window);
      const scoped = app.scoped(request.query.router);
      const loki = new LokiService();

      // The router's own block state, when this build publishes it. Probed
      // rather than assumed: older builds emit only the per-chain COUNT of
      // blocked providers, which cannot name one, and an empty vector from a
      // family that does not exist must not read as "serving".
      const sel = `{spec="${spec}",provider_address="${upstream}"}`;
      const [report, faults, lines, blockedRows, tierRows] = await Promise.all([
        scoped.metricsDetail.status(window),
        scoped.metricsDetail.providerFaults(window),
        // Absent Loki the verdict rests on codes alone, which is weaker but
        // still honest — the prompt is told what it has, never told it is complete.
        loki.available
          ? loki.recentErrors(spec, upstream, 200).catch(() => [])
          : Promise.resolve([]),
        app.prom.query(`${OPTIONAL_METRICS.csmProviderBlocked}${sel}`),
        app.prom.query(`${OPTIONAL_METRICS.endpointServingTier}{spec="${spec}"}`),
      ]);

      // A sample present = the family exists and this is its current value.
      // No sample = the build does not publish it, which stays null.
      const blockedSample = blockedRows[0];
      const blocked = blockedSample
        ? {
            state: (Number(blockedSample.value[1]) === 1 ? "blocked" : "serving") as "blocked" | "serving",
            reason: blockedSample.metric.reason ?? null,
          }
        : null;
      const tierValue = tierRows[0] ? Number(tierRows[0].value[1]) : null;
      const servingTier =
        tierValue === 2 ? "primaries" : tierValue === 1 ? "backups-only" : tierValue === 0 ? "none" : null;

      const findings = report.findings.filter((f) => f.spec === spec && f.upstream === upstream);
      const chainName = findings[0]?.chainName ?? spec;

      // The peers: every OTHER provider on this chain, and whether the page has
      // a finding against it in the same window. This is what separates "this
      // node is broken" from "the chain is".
      const peerNames = new Set<string>();
      for (const f of report.findings) {
        if (f.spec === spec && f.upstream && f.upstream !== upstream) peerNames.add(f.upstream);
      }
      const fault = faults.providers.find((p) => p.provider === upstream);
      for (const c of fault?.chains ?? []) {
        if (c.spec !== spec) continue;
      }
      const peers = [...peerNames].map((name) => {
        const theirs = report.findings.filter((f) => f.spec === spec && f.upstream === name);
        return {
          upstream: name,
          failing: theirs.length > 0,
          note: theirs.map((f) => f.headline).join("; "),
        };
      });

      // Elsewhere: the same provider's other chains, from the per-provider
      // fault rollup rather than inferred.
      const otherChains = (fault?.chains ?? [])
        .filter((c) => c.spec !== spec && (c.answeredWithError > 0 || c.unreachable > 0))
        .slice(0, 8)
        .map((c) => ({
          spec: c.spec,
          chainName: c.name,
          note: `${c.answeredWithError} error answers, ${c.unreachable} unreachable`,
        }));

      try {
        const svc = new FailureAnalysisService(new BedrockService(config.bedrock.model, app.log), app.log);
        const analysis = await svc.analyse({
          spec,
          chainName,
          upstream,
          role: findings[0]?.role ?? null,
          findings,
          errorGroups: groupErrors(lines, 6),
          peers,
          otherChains,
          blocked,
          servingTier,
        });
        return {
          ok: true,
          ...analysis,
          // What it had to work with, so a thin verdict is explicable.
          read: {
            findings: findings.length,
            errorGroups: groupErrors(lines, 6).length,
            peers: peers.length,
            otherChains: otherChains.length,
            // Names the gap rather than hiding it: a verdict reached without
            // the router's own block state is a weaker verdict.
            blockStateAvailable: blocked !== null,
          },
        };
      } catch (err) {
        reply.status(502);
        return {
          ok: false,
          reason: "model_call_failed",
          awsErrorName: err instanceof BedrockError ? err.awsErrorName : null,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  app.post<{ Querystring: { id?: string; router?: string } }>(
    "/api/ai/incident-explain",
    {
      config: { rateLimit: { max: config.bedrock.rateLimitMax, timeWindow: "1 minute" } },
      schema: {
        tags: ["AI"],
        summary: "Explain one incident as numbered steps, in the team's own style",
        description:
          "Takes an incident `id` from GET /api/metrics/incidents. Joins the episode's real " +
          "error lines and the chain's configured providers, and returns the causal chain as " +
          "ordered steps plus a conclusion — the shape this team already writes in Slack. " +
          "The step that matters is why failover did not save it, which the config answers " +
          "and the metrics cannot.",
      },
    },
    async (request, reply) => {
      const id = request.query.id;
      if (!id) {
        reply.status(400);
        return { error: "id is required — take it from GET /api/metrics/incidents" };
      }

      const g = gate();
      if (!g.ok) {
        reply.status(503);
        return { ...g, ...target() };
      }

      const report = await new IncidentsService(app.prom, app.routerConfig).incidents(24);

      // An incident id is `<spec>:<startUnix>`, and it is a handle into a set
      // that is RE-DERIVED on every call: episodes come from a range query
      // whose buckets align to `now`, so the boundaries move between the read
      // that produced the id and this one. An exact match 404s a caller who
      // did nothing wrong, seconds after the list was on their screen.
      //
      // So: exact match first, then the episode on that chain whose window
      // contains the timestamp — the same incident, re-bucketed.
      const [idSpec, idStartRaw] = id.split(":");
      const idStart = Number(idStartRaw);
      const incident =
        report.incidents.find((i) => i.id === id) ??
        (idSpec && Number.isFinite(idStart)
          ? report.incidents.find(
              (i) => i.spec === idSpec && idStart >= i.startUnix - 600 && idStart <= i.endUnix + 600,
            )
          : undefined);

      if (!incident) {
        reply.status(404);
        return { error: "no incident with that id in the last 24h" };
      }

      // The episode's own window, with a minute of slack for clock skew between
      // the counter scrape and the log line.
      const loki = new LokiService();
      const lines = loki.available
        ? await loki
            .recentErrors(incident.spec, undefined, 200, incident.startUnix - 60, incident.endUnix + 60)
            .catch(() => [])
        : [];

      // What COULD have taken over. This is what turns "the provider was slow"
      // into "and nothing else was eligible", which is the actionable half.
      const configured = (app.routerConfig?.getRouters() ?? [])
        .filter((r) => r.spec === incident.spec)
        .flatMap((r) =>
          r.nodes.map((n) => ({
            upstream: n.name,
            role: (n.isBackup ? "backup" : "primary") as "primary" | "backup",
            addons: [...new Set(n.endpoints.flatMap((e) => e.addons ?? []))],
          })),
        );

      try {
        const svc = new IncidentExplainService(new BedrockService(config.bedrock.model, app.log), app.log);
        const explanation = await svc.explain({
          incident,
          errorGroups: groupErrors(lines, 6),
          configured,
        });
        return {
          ok: true,
          ...explanation,
          chain: incident.chainName,
          read: { errorGroups: groupErrors(lines, 6).length, configuredProviders: configured.length },
        };
      } catch (err) {
        reply.status(502);
        return {
          ok: false,
          reason: "model_call_failed",
          awsErrorName: err instanceof BedrockError ? err.awsErrorName : null,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  app.post<{ Querystring: { spec?: string; window?: string; router?: string } }>(
    "/api/ai/chain-analysis",
    {
      config: { rateLimit: { max: config.bedrock.rateLimitMax, timeWindow: "1 minute" } },
      schema: {
        tags: ["AI"],
        summary: "One chain: its providers, and their errors clustered with the explanation",
        description:
          "The container is the CHAIN, for the customer who asks what is happening with " +
          "theirs. Inside it the providers; inside each provider, batches of errors that " +
          "share a cause, with the explanation on the batch rather than on a code. Uses " +
          "the real error TEXT from the logs, and the config's addons — an addon only one " +
          "provider declares is why a failure there has nowhere to fail over to.",
      },
    },
    async (request, reply) => {
      const spec = request.query.spec;
      if (!spec) {
        reply.status(400);
        return { error: "spec is required" };
      }

      const g = gate();
      if (!g.ok) {
        reply.status(503);
        return { ...g, ...target() };
      }

      const window = parseWindow(request.query.window);
      const scoped = app.scoped(request.query.router);
      const loki = new LokiService();

      const [report, lines] = await Promise.all([
        scoped.metricsDetail.status(window),
        loki.available ? loki.recentErrors(spec, undefined, 300).catch(() => []) : Promise.resolve([]),
      ]);

      const findings = report.findings.filter((f) => f.spec === spec);
      const chainName = findings[0]?.chainName ?? spec;

      const configured = (app.routerConfig?.getRouters() ?? [])
        .filter((r) => r.spec === spec)
        .flatMap((r) =>
          r.nodes.map((n) => ({
            upstream: n.name,
            role: (n.isBackup ? "backup" : "primary") as "primary" | "backup",
            addons: [...new Set(n.endpoints.flatMap((e) => e.addons ?? []))],
          })),
        );

      try {
        const svc = new ChainAnalysisService(new BedrockService(config.bedrock.model, app.log), app.log);
        const analysis = await svc.analyse({
          spec,
          chainName,
          findings,
          // More groups than the per-pair view: this covers every provider on
          // the chain, so the clusters have to come from all of them.
          errorGroups: groupErrors(lines, 12),
          configured,
        });
        return {
          ok: true,
          ...analysis,
          read: {
            findings: findings.length,
            errorGroups: groupErrors(lines, 12).length,
            configuredProviders: configured.length,
            logsAvailable: loki.available,
          },
        };
      } catch (err) {
        reply.status(502);
        return {
          ok: false,
          reason: "model_call_failed",
          awsErrorName: err instanceof BedrockError ? err.awsErrorName : null,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  app.post<{ Querystring: { hours?: string; limit?: string; router?: string } }>(
    "/api/ai/incident-feed",
    {
      config: { rateLimit: { max: config.bedrock.rateLimitMax, timeWindow: "1 minute" } },
      schema: {
        tags: ["AI"],
        summary: "The incident feed — every recent incident, explained",
        description:
          "Detects incidents once and explains each in the same pass, so nothing is looked " +
          "up by an id that a later re-detection has already moved. Each item is the causal " +
          "chain in the team's own style, built from the episode's own error lines and the " +
          "chain's configured providers. `hours` (default 24), `limit` (default 5).",
      },
    },
    async (request, reply) => {
      const g = gate();
      if (!g.ok) {
        reply.status(503);
        return { ...g, ...target() };
      }

      const hours = Math.min(Math.max(Number(request.query.hours) || 24, 1), 72);
      const limit = Math.min(Math.max(Number(request.query.limit) || 5, 1), 10);

      // ONE detection for the whole feed. Looking each incident up by id
      // afterwards is what produced 404s on a list that was correct when it
      // was read: episodes are re-derived per call and the ranking moves.
      const report = await new IncidentsService(app.prom, app.routerConfig).incidents(hours);
      const incidents = report.incidents.slice(0, limit);
      if (incidents.length === 0) {
        return { ok: true, hours, incidents: [], note: "no incident crossed the floor in this window" };
      }

      const loki = new LokiService();
      const routers = app.routerConfig?.getRouters() ?? [];
      const svc = new IncidentExplainService(new BedrockService(config.bedrock.model, app.log), app.log);

      const items = await Promise.all(
        incidents.map(async (incident) => {
          const lines = loki.available
            ? await loki
                .recentErrors(incident.spec, undefined, 200, incident.startUnix - 60, incident.endUnix + 60)
                .catch(() => [])
            : [];
          const configured = routers
            .filter((r) => r.spec === incident.spec)
            .flatMap((r) =>
              r.nodes.map((n) => ({
                upstream: n.name,
                role: (n.isBackup ? "backup" : "primary") as "primary" | "backup",
                addons: [...new Set(n.endpoints.flatMap((e) => e.addons ?? []))],
              })),
            );

          const base = {
            id: incident.id,
            spec: incident.spec,
            chain: incident.chainName,
            startUnix: incident.startUnix,
            endUnix: incident.endUnix,
            ongoing: incident.ongoing,
            failures: incident.failures,
            recovered: incident.retriesRecovered,
          };

          try {
            const explanation = await svc.explain({ incident, errorGroups: groupErrors(lines, 6), configured });
            return { ...base, ...explanation, explained: true as const };
          } catch (err) {
            // One item failing must not empty the feed: the others are still
            // worth reading, and a row that says why it has no explanation is
            // more use than a row silently missing.
            return {
              ...base,
              explained: false as const,
              error: err instanceof Error ? err.message : String(err),
              // The deterministic story the page already computes, so the row
              // is never blank.
              steps: incident.story,
              conclusion: "",
              owner: "undetermined" as const,
            };
          }
        }),
      );

      return {
        ok: true,
        hours,
        computedAtUnix: report.computedAtUnix,
        logsAvailable: loki.available,
        configAvailable: routers.length > 0,
        incidents: items,
      };
    },
  );

  app.get(
    "/api/ai/incident-feed",
    {
      schema: {
        tags: ["AI"],
        summary: "The incident feed, from the warm cache — instant",
        description:
          "Served from the background loop, so the page opens on it rather than waiting ~35s " +
          "for a recompute. Each item carries `isNew` (first time it appeared — what a " +
          "notifier fires on) and `explainedAtUnix`. 503 with `reason: cold` before the " +
          "first cycle finishes; POST the same path to force one.",
      },
    },
    async (_request, reply) => {
      const g = gate();
      if (!g.ok) {
        reply.status(503);
        return { ...g, ...target() };
      }
      const feed = app.incidentFeed.current;
      if (!feed) {
        // Distinct from "AI is off": the loop is running and has not finished
        // its first cycle, which is a wait, not a misconfiguration.
        reply.status(503);
        return { ok: false, reason: "cold", detail: "the first feed cycle has not finished yet" };
      }
      return { ok: true, ...feed };
    },
  );

  app.post<{ Querystring: { window?: string; limit?: string; router?: string } }>(
    "/api/ai/issues",
    {
      config: { rateLimit: { max: config.bedrock.rateLimitMax, timeWindow: "1 minute" } },
      schema: {
        tags: ["AI"],
        summary: "Formulated issues — one per affected chain, in the order people ask",
        description:
          "Groups the findings by chain and writes each as a statement answering, in order: " +
          "what happened, why, whether the router failed over and what happened when it did, " +
          "and whether you can work. The third and fourth are what nothing else on the page " +
          "answers. Severity comes from the findings' own tier, never from the model.",
      },
    },
    async (request, reply) => {
      const g = gate();
      if (!g.ok) {
        reply.status(503);
        return { ...g, ...target() };
      }

      const window = parseWindow(request.query.window);
      const limit = Math.min(Math.max(Number(request.query.limit) || 6, 1), 12);
      const scoped = app.scoped(request.query.router);
      const loki = new LokiService();

      const report = await scoped.metricsDetail.status(window);

      // One issue per CHAIN: several rules crossing on one chain are one thing
      // happening, not three problems.
      const bySpec = new Map<string, typeof report.findings>();
      for (const f of report.findings) {
        const list = bySpec.get(f.spec) ?? [];
        list.push(f);
        bySpec.set(f.spec, list);
      }

      // The same outcome read the background feed uses, so a chain gets the
      // same badge whichever path wrote it. A failed read costs the outcome
      // sentence, never the issues.
      const outcomeOf = await outcomesBySpec(app.prom, window).catch(
        () => () => ({ recovered: null, failures: null, requests: null, addonCalls: [] }),
      );

      // Worst chains first, so a truncated list never drops a critical one.
      const rank = { critical: 0, degraded: 1, config: 2 } as const;
      const sev = (spec: string, f: typeof report.findings) => severityOf(f, outcomeOf(spec));
      const chains = [...bySpec.entries()]
        .sort((a, b) => rank[sev(a[0], a[1])] - rank[sev(b[0], b[1])] || b[1].length - a[1].length)
        .slice(0, limit);

      const routers = app.routerConfig?.getRouters() ?? [];
      const svc = new FormulatedIssueService(new BedrockService(config.bedrock.model, app.log), app.log);

      const issues = await Promise.all(
        chains.map(async ([spec, findings]) => {
          const lines = loki.available
            ? await loki.recentErrors(spec, undefined, 150).catch(() => [])
            : [];
          const configured = routers
            .filter((r) => r.spec === spec)
            .flatMap((r) =>
              r.nodes.map((n) => ({
                upstream: n.name,
                role: (n.isBackup ? "backup" : "primary") as "primary" | "backup",
                addons: [...new Set(n.endpoints.flatMap((e) => e.addons ?? []))],
              })),
            );
          try {
            return await svc.formulate({
              spec,
              chain: findings[0]?.chainName ?? spec,
              findings,
              errorGroups: groupErrors(lines, 6),
              configured,
              insights: report.insights.filter((x) => x.spec === spec),
              ...outcomeOf(spec),
            });
          } catch (err) {
            app.log.warn({ spec, err: String(err) }, "could not formulate an issue");
            return null;
          }
        }),
      );

      return {
        ok: true,
        window,
        logsAvailable: loki.available,
        configAvailable: routers.length > 0,
        issues: issues.filter((i): i is NonNullable<typeof i> => i !== null),
      };
    },
  );

  app.get<{ Querystring: { window?: string } }>(
    "/api/ai/issues",
    {
      schema: {
        tags: ["AI"],
        summary: "The written issues, from the warm cache — instant",
        description:
          "Served from the background loop. Each chain's issue is memoised on a fingerprint " +
          "of its findings, so unchanged findings keep the sentence already written rather " +
          "than being re-worded every cycle. `warming: true` means this window is being " +
          "computed now — the loop warms the default window, another is computed on first ask.",
      },
    },
    async (request, reply) => {
      const g = gate();
      if (!g.ok) {
        reply.status(503);
        return { ...g, ...target() };
      }
      const window = parseWindow(request.query.window);
      const snapshot = app.issuesFeed.current(window);
      if (snapshot) return { ok: true, warming: false, ...snapshot };

      // Nothing for this window yet. Start it and say so — "working on it" and
      // "not configured" must not look the same to the page.
      //
      // 200, NOT 503: the web's apiGet throws on a non-2xx, and SWR then keeps
      // the PREVIOUS data while it retries. Changing the window therefore left
      // the last window's issues on screen with nothing saying they were
      // stale. Warming is a state, not a failure, so it comes back as one.
      if (!app.issuesFeed.isRunning(window)) {
        // Logged, never swallowed: an empty catch here means a compute that
        // fails on every attempt looks identical to one still running, and
        // the page polls a 503 forever with nothing in the log to explain it.
        void app.issuesFeed.refresh(window).catch((err) => {
          app.log.warn(
            { window, err: err instanceof Error ? err.message : String(err) },
            "issues feed could not compute this window",
          );
        });
      }
      return { ok: false, warming: true, reason: "warming", detail: "computing this window now" };
    },
  );
}
