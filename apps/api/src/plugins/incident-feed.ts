import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { IncidentFeedService } from "../services/incident-feed.js";
import { IssuesFeedService } from "../services/issues-feed.js";
import { config } from "../config.js";

/**
 * Keep the incident feed AND the written issues warm, so the page opens on
 * them rather than on a button that starts a 68-second wait.
 *
 * A cycle explains only incidents it has not seen (see `IncidentFeedService`),
 * so a quiet interval costs nothing and an unchanged item never gets re-worded.
 * The interval is five minutes because that is the incident bucket: checking
 * faster cannot find anything new.
 *
 * Unref'd — a warm cache must never hold the process open, in tests or on a
 * shutdown that is waiting for the event loop to drain.
 */
const INTERVAL_MS = 5 * 60_000;

declare module "fastify" {
  interface FastifyInstance {
    incidentFeed: IncidentFeedService;
    issuesFeed: IssuesFeedService;
  }
}

export const incidentFeedPlugin = fp(async (app: FastifyInstance) => {
  const feed = new IncidentFeedService(app.prom, app.routerConfig, app.log);
  app.decorate("incidentFeed", feed);
  const issues = new IssuesFeedService(app.metricsDetail, app.routerConfig, app.log, {
    prom: app.prom,
    stateFile: config.issues.stateFile,
  });
  app.decorate("issuesFeed", issues);

  // Tests assert against per-test fetch stubs; a loop would fire a model call
  // into whichever stub happened to be installed.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  if (!config.bedrock.enabled) return;

  const tick = (): void => {
    void feed.refresh().catch((err) => {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "incident feed cycle failed");
    });
    // The written issues for the window the page opens on. Sequential with
    // the above only by virtue of both being fire-and-forget; each guards its
    // own overlap, so a slow cycle cannot stack.
    void issues.refresh().catch((err) => {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "issues feed cycle failed");
    });
  };

  // One cycle at boot so the first visitor does not wait 35s for a cold feed,
  // deferred a little so it does not contend with everything else starting.
  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, INTERVAL_MS);
  first.unref();
  timer.unref();
  app.addHook("onClose", async () => {
    clearTimeout(first);
    clearInterval(timer);
  });
});
