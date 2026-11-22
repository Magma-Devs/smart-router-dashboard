import type { FastifyInstance } from "fastify";
import { readAskSettings } from "../../config.js";
import { AskBudget } from "./budget.js";
import { AskFailure } from "./errors.js";
import { askErrorFields } from "./log-fields.js";
import { assertCurrentPricing, readAskBillingSettings } from "./pricing.js";
import { AskRetention } from "./retention.js";
import { AskStore, type AskAdmission } from "./store.js";
import { AskSwitchState } from "./switch.js";
import { AskWorker } from "./worker.js";
import { drainRemainingMs } from "../../shutdown.js";

/** Admission requires readiness. A replica awaiting its first switch read must
 * pause claims, never interrupt another replica's already admitted questions. */
export function installAskRuntime(app: FastifyInstance): {
  admit: AskAdmission;
  ready: () => boolean;
  switched: (off: boolean) => void;
  submitted: () => void;
} {
  let stopped = false;
  let worker: AskWorker | null = null;
  let budget: AskBudget | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let switchTimer: ReturnType<typeof setInterval> | null = null;
  let turnedOff: AskSwitchState | null = null;
  let sweeping: Promise<void> = Promise.resolve();
  let sweepBusy = false;
  const settings = readAskSettings();
  const billing = readAskBillingSettings(settings);
  const ready = () => {
    if (
      stopped ||
      !worker ||
      !budget ||
      !billing ||
      !turnedOff ||
      turnedOff.off ||
      !settings.enabled ||
      !readAskSettings().enabled ||
      settings.problem
    )
      return false;
    try {
      assertCurrentPricing(billing.pricing);
      return true;
    } catch {
      return false;
    }
  };
  const start = app.dbReady
    .then(() => {
      if (
        stopped ||
        !app.db ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(settings.customerId) ||
        (process.env.DEPLOYMENT_MODE ?? "onprem") !== "managed"
      )
        return;
      // Every replica rereads the admins' switch each second; until its first
      // read answers, this replica counts Ask as off.
      if (settings.enabled) {
        const switchState = new AskSwitchState(app.db, settings.customerId);
        turnedOff = switchState;
        const reread = () => {
          if (!stopped) void switchState.refresh().catch(() => undefined);
        };
        switchTimer = setInterval(reread, 1000);
        switchTimer.unref();
        reread();
      }
      const store = new AskStore(app.db, settings.customerId, settings.retentionDays);
      const retention = new AskRetention(app.db, settings.customerId, settings.retentionDays);
      budget = new AskBudget(app.db, settings, billing);
      if (billing && !settings.problem) {
        worker = new AskWorker(store, settings, {
          hooks: (run) => budget!.hooks(run),
          afterTerminal: (id) => budget!.reconcile(id),
          enabled: () => settings.enabled && readAskSettings().enabled && !turnedOff?.confirmedOff,
          canClaim: ready,
          onError: (code, error) =>
            app.log.error(
              { code, ...(error === undefined ? {} : askErrorFields(error)) },
              "Ask worker operation failed",
            ),
          timing: (runId, phase, durationMs) =>
            app.log.info(
              { runId, phase, durationMs: Math.round(durationMs) },
              "Ask execution timing",
            ),
        });
        worker.start();
      }
      const sweep = () => {
        if (stopped || sweepBusy) return;
        sweepBusy = true;
        sweeping = (async () => {
          await store.recover(settings.runTimeoutMs);
          await budget?.reconcile();
          await retention.sweep();
        })()
          .catch((error: unknown) => {
            app.log.error(
              { code: "ASK_MAINTENANCE_FAILED", ...askErrorFields(error) },
              "Ask maintenance failed",
            );
          })
          .finally(() => {
            sweepBusy = false;
          });
      };
      timer = setInterval(sweep, 60_000);
      timer.unref();
      sweep();
    })
    .catch((error: unknown) => {
      if (!stopped)
        app.log.error(
          { code: "ASK_START_FAILED", ...askErrorFields(error) },
          "Ask runtime failed to start",
        );
    });
  // Claims stop as the close begins, before in-flight requests finish. A
  // stopping replica is not a disable: its running answers carry on, and the
  // questions it never claimed stay queued for another replica.
  app.addHook("preClose", async () => {
    stopped = true;
  });
  app.addHook("onClose", async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    if (switchTimer) clearInterval(switchTimer);
    // Runs get what is left of a stop signal's drain, then are interrupted,
    // which ends their leases. The database pool closes after this hook.
    await worker?.stop(drainRemainingMs(app));
    await sweeping;
    // Do not wait for the database's indefinite startup retry loop.
    void start;
  });
  return {
    ready,
    switched: (off) => turnedOff?.remember(off),
    // The replica that saved a question claims it now; the others still poll.
    submitted: () => worker?.wake(),
    admit: async (tx, run) => {
      if (!ready() || !budget) throw new AskFailure("ASK_UNAVAILABLE");
      await budget.admit(tx, run);
    },
  };
}
