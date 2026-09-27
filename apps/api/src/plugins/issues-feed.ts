import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { IssuesFeedService } from "../services/issues-feed.js";
import { config } from "../config.js";

/**
 * Keep the issue log current, so the page opens on it rather than on a
 * button that starts a minute-long wait.
 *
 * One cycle every five minutes: the log's live window is read, each problem
 * is opened, updated or resolved, and the model runs only for an issue whose
 * facts changed. Five minutes because that is the resolution the checks
 * themselves have — a burst of failures is judged over five minutes, the same
 * as the team's alert — so checking faster finds nothing new.
 *
 * Unref'd — the loop must never hold the process open, in tests or on a
 * shutdown that is waiting for the event loop to drain.
 */
const INTERVAL_MS = 5 * 60_000;

declare module "fastify" {
  interface FastifyInstance {
    issuesFeed: IssuesFeedService;
  }
}

export const issuesFeedPlugin = fp(async (app: FastifyInstance) => {
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
    // Guards its own overlap, so a slow cycle cannot stack.
    void issues.refresh().catch((err) => {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "issues feed cycle failed");
    });
  };

  // One cycle at boot so the first visitor does not wait on a cold log,
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
