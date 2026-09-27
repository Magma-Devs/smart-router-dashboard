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
import { BedrockError, BedrockService, bedrockGate, isLoopback } from "../services/bedrock.js";
import { StatusAiService } from "../services/status-ai.js";
import { FailureAnalysisService } from "../services/failure-analysis.js";
import { ChainAnalysisService } from "../services/chain-analysis.js";
import { WINDOWS } from "@sr/shared";
import { FormulatedIssueService, severityOf } from "../services/formulated-issues.js";
import { outcomesBySpec, readLogs } from "../services/issues-feed.js";
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
  // Said once, at boot: a flag that silently does nothing is a support ticket.
  // The deployment asked for unauthenticated AI on an address others can
  // reach, and the gate will refuse every call until it signs people in.
  if (
    config.bedrock.enabled &&
    config.bedrock.allowUnauthenticated &&
    config.auth.mode !== "enabled" &&
    !isLoopback(config.server.host)
  ) {
    app.log.warn(
      { host: config.server.host },
      "BEDROCK_ALLOW_UNAUTHENTICATED is ignored: the api listens beyond loopback — set AUTH_MODE=enabled, or API_HOST=127.0.0.1 for a local run",
    );
  }

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
          "Reads the whole Status report and returns correlated themes — the join the page " +
          "cannot make, since one provider can appear as a finding on one chain and an " +
          "insight on another with nothing linking them. Every theme cites the finding ids it rests on; any that cites nothing real " +
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
      // Read regardless of the model — a brief over a half-read report would
      // be worse than no brief.
      const report = await scoped.metricsDetail.status(parseWindow(request.query.window));

      const startedAt = Date.now();
      try {
        const svc = new StatusAiService(
          new BedrockService(config.bedrock.model, app.log),
          app.log,
        );
        const analysis = await svc.analyse(report);
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
      const logs = loki.available
        ? await readLogs(loki, WINDOWS[window].rangeSeconds, app.routerConfig?.getRouters() ?? []).catch(() => null)
        : null;
      const outcomeOf = await outcomesBySpec(app.prom, window, logs).catch(
        () => () => ({ recovered: null, failures: null, requests: null, addonCalls: [], writes: null, paths: null }),
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
              measured: { fromUnix: report.computedAtUnix - WINDOWS[window].rangeSeconds, toUnix: report.computedAtUnix },
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
        summary: "The issue log, filtered to the window — instant",
        description:
          "One issue per problem for as long as it lasts: a stable `id`, `status` open or " +
          "resolved, `openedAtUnix`, `updatedAtUnix`, `resolvedAtUnix`, `severitySinceUnix`. " +
          "A background cycle updates the log every 5 minutes; `window` filters it to the " +
          "issues active at any point inside it, with no model call. `warming: true` only " +
          "before the first cycle has finished.",
      },
    },
    async (request, reply) => {
      const g = gate();
      if (!g.ok) {
        reply.status(503);
        return { ...g, ...target() };
      }
      const window = parseWindow(request.query.window);
      // A filter over the issue log, never a new analysis: changing the
      // window is instant because the model only runs in the background.
      const view = app.issuesFeed.view(window);
      if (view) return { ok: true, warming: false, ...view };

      // No cycle has finished yet — the first minute after a boot. Start one
      // and say so: "working on it" and "not configured" must not look the
      // same to the page.
      //
      // 200, NOT 503: the web's apiGet throws on a non-2xx, and SWR then keeps
      // the PREVIOUS data while it retries. Warming is a state, not a failure.
      if (!app.issuesFeed.isRunning()) {
        // Logged, never swallowed: an empty catch here means a cycle that
        // fails every time looks identical to one still running.
        void app.issuesFeed.refresh().catch((err) => {
          app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "issues feed cycle failed");
        });
      }
      return { ok: false, warming: true, reason: "warming", detail: "reading the first cycle" };
    },
  );
}
