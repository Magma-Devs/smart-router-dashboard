import { and, eq, inArray, sql } from "drizzle-orm";
import {
  askBudgetMonths,
  askModelSteps,
  askRuns,
  askToolEvents,
  type AskModelStepRow,
  type AskRunRow,
  type Database,
} from "@sr/db";
import type { AskSettings } from "../../config.js";
import type { BedrockReceipt, BedrockUsage } from "./bedrock.js";
import { AskFailure } from "./errors.js";
import type { AskExecutionHooks } from "./orchestrator.js";
import {
  assertCurrentPricing,
  askPricingSchema,
  inputTokenBound,
  maximumStepCost,
  observedStepCost,
  type AskBillingSettings,
} from "./pricing.js";
import { AskStore, type AskAdmission, type AskTransaction } from "./store.js";
import { admittedBySwitch } from "./switch.js";

/** The outcome of each statement a transaction sent together, read in the
 * order they were sent: `take(i)` throws statement i's error, so a caller that
 * checks results between takes fails where a one-at-a-time transaction would. */
async function sent<T extends readonly unknown[]>(
  statements: Readonly<{ [K in keyof T]: PromiseLike<T[K]> }>,
): Promise<<I extends number>(index: I) => T[I]> {
  const settled = await Promise.allSettled(statements as unknown as PromiseLike<unknown>[]);
  return (index) => {
    const outcome = settled[index]!;
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value as T[typeof index];
  };
}

/** Lock order: current run (when required), monthly pool, then step. Every
 * reservation/settlement mutates that one shared customer/month pool atomically. */
export class AskBudget {
  private readonly store: AskStore;
  constructor(
    private readonly db: Database,
    private readonly settings: AskSettings,
    private readonly billing: AskBillingSettings | null,
  ) {
    this.store = new AskStore(db, settings.customerId, settings.retentionDays);
  }
  private get configured(): AskBillingSettings {
    if (!this.billing) throw new AskFailure("ASK_UNAVAILABLE");
    return this.billing;
  }
  private poolKey(month: string) {
    return and(
      eq(askBudgetMonths.customerId, this.settings.customerId),
      eq(askBudgetMonths.month, month),
    );
  }
  /** The pool row for a month, created at the configured limit or lowered to
   * it, and locked. A null month is this statement's own UTC month, and the
   * row comes back with the instant that month was read at. */
  private pool(tx: AskTransaction, month: string | null) {
    return tx
      .insert(askBudgetMonths)
      .values({
        customerId: this.settings.customerId,
        month: month ?? sql`to_char(clock_timestamp() at time zone 'UTC','YYYY-MM')`,
        limitMicroUsd: this.configured.monthlyLimitMicroUsd,
      })
      .onConflictDoUpdate({
        target: [askBudgetMonths.customerId, askBudgetMonths.month],
        set: {
          limitMicroUsd: sql`least(${askBudgetMonths.limitMicroUsd}, ${this.configured.monthlyLimitMicroUsd})`,
        },
      })
      .returning({
        month: askBudgetMonths.month,
        spentMicroUsd: askBudgetMonths.spentMicroUsd,
        reservedMicroUsd: askBudgetMonths.reservedMicroUsd,
        limitMicroUsd: askBudgetMonths.limitMicroUsd,
        instant: sql<string>`clock_timestamp()::text`,
      });
  }
  private deny(spent: bigint, reserved: bigint, limit: bigint, amount = 1n) {
    if (spent + amount > limit) throw new AskFailure("ASK_BUDGET_LIMIT", 429);
    if (spent + reserved + amount > limit) throw new AskFailure("ASK_BUDGET_BUSY", 429);
  }
  /** Inside a submission, after its run is inserted: the switch (share-locked)
   * and the pool go together; a refusal rolls the submission back. */
  readonly admit: AskAdmission = async (tx, run) => {
    if (run.customerId !== this.settings.customerId) throw new AskFailure("ASK_IDENTITY_MISMATCH");
    const take = await sent<[boolean, Awaited<ReturnType<AskBudget["pool"]>>]>([
      admittedBySwitch(tx, this.settings.customerId),
      this.billing ? this.pool(tx, null) : Promise.resolve([]),
    ]);
    if (!take(0)) throw new AskFailure("ASK_TURNED_OFF");
    const { pricing } = this.configured;
    const [pool] = take(1);
    assertCurrentPricing(pricing, new Date(pool!.instant));
    this.deny(pool!.spentMicroUsd, pool!.reservedMicroUsd, pool!.limitMicroUsd);
  };
  /** The run's lock, then, as a separate statement that reads time and the
   * session after any lock wait, whether the lease is current. It also reads
   * the clock and how many steps the run has reserved. */
  private active(tx: AskTransaction, run: AskRunRow) {
    return [
      tx
        .select({ id: askRuns.id })
        .from(askRuns)
        .where(and(eq(askRuns.id, run.id), eq(askRuns.customerId, this.settings.customerId)))
        .for("update"),
      tx
        .select({
          month: sql<string>`to_char(clock_timestamp() at time zone 'UTC','YYYY-MM')`,
          instant: sql<string>`clock_timestamp()::text`,
          steps: sql<number>`(select count(*) from ask_model_steps m where m.customer_id=${this.settings.customerId} and m.run_id=${run.id})::int`,
        })
        .from(askRuns)
        .where(
          and(
            eq(askRuns.id, run.id),
            eq(askRuns.customerId, this.settings.customerId),
            eq(askRuns.leaseToken, run.leaseToken!),
            eq(askRuns.status, "running"),
            sql`${askRuns.leaseUntil} > clock_timestamp() and ${askRuns.expiresAt} > clock_timestamp()`,
            sql`exists(select 1 from sessions s join users u on u.id=s.user_id where s.id=${askRuns.sessionId} and s.user_id=${askRuns.ownerId} and s.revoked_at is null and s.expires_at>clock_timestamp() and u.status='active')`,
          ),
        ),
    ] as const;
  }
  private current(
    locked: { id: string }[],
    current: { month: string; instant: string; steps: number }[],
  ) {
    if (!locked[0] || !current[0]) throw new AskFailure("ASK_INTERRUPTED");
    return current[0];
  }
  async reserve(
    run: AskRunRow,
    inputTokenBound: number,
    outputTokenBound: number,
    feature: "ask" | "investigate" = "ask",
  ): Promise<string> {
    const amount = maximumStepCost(this.configured.pricing, inputTokenBound, outputTokenBound);
    return this.db.transaction(async (tx) => {
      const [lock, check] = this.active(tx, run);
      const checked = await sent<
        [{ id: string }[], { month: string; instant: string; steps: number }[]]
      >([lock, check]);
      const clock = this.current(checked(0), checked(1));
      assertCurrentPricing(this.configured.pricing, new Date(clock.instant));
      // The pool, the step and the pool's new reservation go together; each
      // check below runs where it ran when they went one at a time, and a
      // refusal rolls all three back.
      const take = await sent<[Awaited<ReturnType<AskBudget["pool"]>>, { id: string }[], unknown]>([
        this.pool(tx, clock.month),
        tx
          .insert(askModelSteps)
          .values({
            runId: run.id,
            customerId: this.settings.customerId,
            month: clock.month,
            feature,
            state: "reserved",
            inputTokenBound,
            outputTokenBound,
            reservedMicroUsd: amount,
            pricing: this.configured.pricing,
          })
          .returning({ id: askModelSteps.id }),
        tx
          .update(askBudgetMonths)
          .set({
            reservedMicroUsd: sql`${askBudgetMonths.reservedMicroUsd} + ${amount}`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(this.poolKey(clock.month)),
      ]);
      const [pool] = take(0);
      this.deny(pool!.spentMicroUsd, pool!.reservedMicroUsd, pool!.limitMicroUsd, amount);
      if (clock.steps >= this.settings.maxSteps) throw new AskFailure("ASK_LIMIT_REACHED", 422);
      const [step] = take(1);
      take(2);
      return step!.id;
    });
  }
  /** Lock order: the step's pool, then the step. The first statement finds
   * the step (this customer's, this run's when given) and locks its pool. */
  private step(tx: AskTransaction, id: string, runId?: string) {
    return [
      tx
        .select({ month: askBudgetMonths.month })
        .from(askBudgetMonths)
        .where(
          sql`(${askBudgetMonths.customerId}, ${askBudgetMonths.month}) = (select s.customer_id, s.month from ask_model_steps s where s.id=${id} and s.customer_id=${this.settings.customerId}${runId ? sql` and s.run_id=${runId}` : sql``})`,
        )
        .for("update"),
      tx
        .select()
        .from(askModelSteps)
        .where(
          and(eq(askModelSteps.id, id), eq(askModelSteps.customerId, this.settings.customerId)),
        )
        .for("update"),
    ] as const;
  }
  private located(pool: { month: string }[], step: AskModelStepRow[]): AskModelStepRow {
    if (!pool[0] || !step[0]) throw new AskFailure("ASK_NOT_FOUND", 404);
    return step[0];
  }
  async dispatched(run: AskRunRow, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [lock, check] = this.active(tx, run);
      const [pool, step] = this.step(tx, id, run.id);
      // The clock is read after every lock, as it was when each went alone.
      const take = await sent<
        [
          { id: string }[],
          { month: string; instant: string; steps: number }[],
          { month: string }[],
          AskModelStepRow[],
          { month: string; instant: string }[],
        ]
      >([
        lock,
        check,
        pool,
        step,
        tx
          .select({
            month: sql<string>`to_char(clock_timestamp() at time zone 'UTC','YYYY-MM')`,
            instant: sql<string>`clock_timestamp()::text`,
          })
          .from(askRuns)
          .where(and(eq(askRuns.id, run.id), eq(askRuns.customerId, this.settings.customerId))),
      ]);
      this.current(take(0), take(1));
      const located = this.located(take(2), take(3));
      const [clock] = take(4);
      if (!clock) throw new AskFailure("ASK_INTERRUPTED");
      assertCurrentPricing(askPricingSchema.parse(located.pricing), new Date(clock.instant));
      if (located.state !== "reserved" || clock.month !== located.month)
        throw new AskFailure("ASK_INTERRUPTED");
      await tx
        .update(askModelSteps)
        .set({ state: "dispatched", dispatchedAt: sql`clock_timestamp()` })
        .where(eq(askModelSteps.id, id));
    });
  }
  async usage(
    runId: string,
    id: string,
    usage: BedrockUsage | null,
    receipt: BedrockReceipt,
  ): Promise<void> {
    let violation = false;
    await this.db.transaction(async (tx) => {
      const take = await sent<[{ month: string }[], AskModelStepRow[]]>(this.step(tx, id, runId));
      const step = this.located(take(0), take(1));
      if (step.state === "settled" || step.state === "released") return;
      if (step.state === "reserved") throw new AskFailure("ASK_CONFLICT", 409);
      const pricing = askPricingSchema.parse(step.pricing);
      const cost = usage ? observedStepCost(pricing, usage) : null;
      const metadata = {
        usage: (usage as Record<string, unknown> | null) ?? step.usage,
        providerRequestId: receipt.requestId ?? step.providerRequestId,
        providerStatus: receipt.providerStatus ?? step.providerStatus,
      };
      if (cost === null) {
        await tx
          .update(askModelSteps)
          .set({ ...metadata, state: "uncertain" })
          .where(eq(askModelSteps.id, id));
        return;
      }
      violation =
        cost > step.reservedMicroUsd ||
        usage!.inputTokens +
          (usage!.cacheReadInputTokens ?? 0) +
          (usage!.cacheWriteInputTokens ?? 0) >
          step.inputTokenBound ||
        usage!.outputTokens > step.outputTokenBound;
      await sent([
        tx
          .update(askBudgetMonths)
          .set({
            reservedMicroUsd: sql`${askBudgetMonths.reservedMicroUsd} - ${step.reservedMicroUsd}`,
            spentMicroUsd: sql`${askBudgetMonths.spentMicroUsd} + ${cost}`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(this.poolKey(step.month)),
        tx
          .update(askModelSteps)
          .set({
            ...metadata,
            state: "settled",
            chargedMicroUsd: cost,
            completedAt: sql`clock_timestamp()`,
          })
          .where(eq(askModelSteps.id, id)),
      ]).then((take) => {
        take(0);
        take(1);
      });
    });
    if (violation) throw new AskFailure("ASK_LIMIT_REACHED", 503);
  }
  async reconcile(runId?: string): Promise<void> {
    const candidates = await this.db
      .select({ id: askModelSteps.id })
      .from(askModelSteps)
      .where(
        and(
          eq(askModelSteps.customerId, this.settings.customerId),
          inArray(askModelSteps.state, ["reserved", "dispatched"]),
          runId ? eq(askModelSteps.runId, runId) : undefined,
          sql`not exists(select 1 from ask_runs r where r.id=${askModelSteps.runId} and r.customer_id=${this.settings.customerId} and r.status in ('queued','running','cancelling'))`,
        ),
      )
      .limit(100);
    for (const candidate of candidates)
      await this.db.transaction(async (tx) => {
        const take = await sent<[{ month: string }[], AskModelStepRow[]]>(
          this.step(tx, candidate.id),
        );
        const step = this.located(take(0), take(1));
        if (step.state !== "reserved" && step.state !== "dispatched") return;
        if (step.state === "dispatched") {
          await tx
            .update(askModelSteps)
            .set({ state: "uncertain" })
            .where(eq(askModelSteps.id, step.id));
        } else {
          await tx
            .update(askBudgetMonths)
            .set({
              reservedMicroUsd: sql`${askBudgetMonths.reservedMicroUsd} - ${step.reservedMicroUsd}`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(this.poolKey(step.month));
          await tx
            .update(askModelSteps)
            .set({ state: "released", chargedMicroUsd: 0n, completedAt: sql`clock_timestamp()` })
            .where(eq(askModelSteps.id, step.id));
        }
      });
  }
  hooks(run: AskRunRow): AskExecutionHooks {
    // A reservation verifies the lease, the running status and the session in
    // its own transaction. The one lease check that follows within a second
    // (the model call's dispatch) reuses that answer; `dispatched` verifies
    // all three again before a paid request leaves.
    let verifiedAt = 0;
    const reserve = (input: number, output: number) =>
      this.reserve(run, input, output).then((id) => {
        verifiedAt = Date.now();
        return id;
      });
    return {
      checkActive: async () => {
        if (Date.now() - verifiedAt < 1000) {
          verifiedAt = 0;
          return;
        }
        verifiedAt = 0;
        const state = await this.store.leaseState(run.id, run.leaseToken!);
        if (state === "cancelling") throw new AskFailure("ASK_CANCELLED", 409);
        if (state !== "running") throw new AskFailure("ASK_INTERRUPTED");
      },
      beforeModelStep: async ({ input, outputTokens, signal }) => {
        assertCurrentPricing(this.configured.pricing);
        signal?.throwIfAborted();
        // No network call: the request's byte length bounds its input tokens,
        // priced at the highest input-side rate; settlement charges the real usage.
        return reserve(inputTokenBound(input), outputTokens);
      },
      modelDispatched: (id) => this.dispatched(run, id),
      recordUsage: (id, usage, receipt) => this.usage(run.id, id, usage, receipt),
      recordTool: async (tool) => {
        // Audit a read that was already attempted, including cancellation or
        // revocation during it. This grants no further external work and
        // cannot resurrect a terminal/deleted run's retained content. One
        // statement: it locks the run while its lease is current and writes
        // the event only then.
        await this.db.execute(
          sql`with present as (select ${askRuns.id} as id from ${askRuns} where ${and(
            eq(askRuns.id, run.id),
            eq(askRuns.customerId, this.settings.customerId),
            eq(askRuns.leaseToken, run.leaseToken!),
            sql`${askRuns.expiresAt} > clock_timestamp()`,
          )} for update) insert into ${askToolEvents} (run_id, customer_id, source_id, operation_id, parameters, evidence, outcome, latency_ms) select id, ${this.settings.customerId}, ${tool.sourceId}, ${tool.operationId}, ${JSON.stringify(tool.parameters)}::jsonb, ${JSON.stringify(tool.evidence)}::jsonb, ${tool.ok ? "success" : "unavailable"}, ${tool.latencyMs} from present`,
        );
      },
    };
  }
}
