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
import { BedrockAdapter, type BedrockReceipt, type BedrockUsage } from "./bedrock.js";
import { AskFailure } from "./errors.js";
import type { AskExecutionHooks } from "./orchestrator.js";
import {
  assertCurrentPricing,
  askPricingSchema,
  maximumStepCost,
  observedStepCost,
  type AskBillingSettings,
} from "./pricing.js";
import { AskStore, type AskAdmission, type AskTransaction } from "./store.js";
import { admittedBySwitch } from "./switch.js";

/** Lock order: current run (when required), monthly pool, then step. Every
 * reservation/settlement mutates that one shared customer/month pool atomically. */
export class AskBudget {
  private readonly store: AskStore;
  constructor(
    private readonly db: Database,
    private readonly settings: AskSettings,
    private readonly billing: AskBillingSettings | null,
    private readonly fetchImpl?: typeof fetch,
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
  private async clock(tx: AskTransaction, runId: string) {
    const [clock] = await tx
      .select({
        month: sql<string>`to_char(clock_timestamp() at time zone 'UTC','YYYY-MM')`,
        instant: sql<string>`clock_timestamp()::text`,
      })
      .from(askRuns)
      .where(and(eq(askRuns.id, runId), eq(askRuns.customerId, this.settings.customerId)));
    if (!clock) throw new AskFailure("ASK_INTERRUPTED");
    return clock;
  }
  private async pool(tx: AskTransaction, month: string) {
    await tx
      .insert(askBudgetMonths)
      .values({
        customerId: this.settings.customerId,
        month,
        limitMicroUsd: this.configured.monthlyLimitMicroUsd,
      })
      .onConflictDoUpdate({
        target: [askBudgetMonths.customerId, askBudgetMonths.month],
        set: {
          limitMicroUsd: sql`least(${askBudgetMonths.limitMicroUsd}, ${this.configured.monthlyLimitMicroUsd})`,
        },
      });
    const [pool] = await tx.select().from(askBudgetMonths).where(this.poolKey(month)).for("update");
    return pool!;
  }
  private deny(spent: bigint, reserved: bigint, limit: bigint, amount = 1n) {
    if (spent + amount > limit) throw new AskFailure("ASK_BUDGET_LIMIT", 429);
    if (spent + reserved + amount > limit) throw new AskFailure("ASK_BUDGET_BUSY", 429);
  }
  readonly admit: AskAdmission = async (tx, run) => {
    if (run.customerId !== this.settings.customerId) throw new AskFailure("ASK_IDENTITY_MISMATCH");
    if (!(await admittedBySwitch(tx, this.settings.customerId)))
      throw new AskFailure("ASK_TURNED_OFF");
    const clock = await this.clock(tx, run.id);
    assertCurrentPricing(this.configured.pricing, new Date(clock.instant));
    const pool = await this.pool(tx, clock.month);
    this.deny(pool.spentMicroUsd, pool.reservedMicroUsd, pool.limitMicroUsd);
  };
  private async active(tx: AskTransaction, run: AskRunRow) {
    // Lock first; a separate statement evaluates time/session after lock waits.
    const [locked] = await tx
      .select({ id: askRuns.id })
      .from(askRuns)
      .where(and(eq(askRuns.id, run.id), eq(askRuns.customerId, this.settings.customerId)))
      .for("update");
    if (!locked) throw new AskFailure("ASK_INTERRUPTED");
    const [current] = await tx
      .select({ id: askRuns.id })
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
      );
    if (!current) throw new AskFailure("ASK_INTERRUPTED");
  }
  async reserve(
    run: AskRunRow,
    inputTokenBound: number,
    outputTokenBound: number,
    feature: "ask" | "investigate" = "ask",
  ): Promise<string> {
    const amount = maximumStepCost(this.configured.pricing, inputTokenBound, outputTokenBound);
    return this.db.transaction(async (tx) => {
      await this.active(tx, run);
      const clock = await this.clock(tx, run.id);
      assertCurrentPricing(this.configured.pricing, new Date(clock.instant));
      const pool = await this.pool(tx, clock.month);
      this.deny(pool.spentMicroUsd, pool.reservedMicroUsd, pool.limitMicroUsd, amount);
      const previous = await tx
        .select({ id: askModelSteps.id })
        .from(askModelSteps)
        .where(
          and(
            eq(askModelSteps.customerId, this.settings.customerId),
            eq(askModelSteps.runId, run.id),
          ),
        );
      if (previous.length >= this.settings.maxSteps) throw new AskFailure("ASK_LIMIT_REACHED", 422);
      const [step] = await tx
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
        .returning({ id: askModelSteps.id });
      await tx
        .update(askBudgetMonths)
        .set({
          reservedMicroUsd: sql`${askBudgetMonths.reservedMicroUsd} + ${amount}`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(this.poolKey(clock.month));
      return step!.id;
    });
  }
  private async step(tx: AskTransaction, id: string, runId?: string): Promise<AskModelStepRow> {
    const [located] = await tx
      .select()
      .from(askModelSteps)
      .where(
        and(
          eq(askModelSteps.id, id),
          eq(askModelSteps.customerId, this.settings.customerId),
          runId ? eq(askModelSteps.runId, runId) : undefined,
        ),
      );
    if (!located) throw new AskFailure("ASK_NOT_FOUND", 404);
    await tx.select().from(askBudgetMonths).where(this.poolKey(located.month)).for("update");
    const [step] = await tx
      .select()
      .from(askModelSteps)
      .where(eq(askModelSteps.id, id))
      .for("update");
    return step!;
  }
  async dispatched(run: AskRunRow, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.active(tx, run);
      const step = await this.step(tx, id, run.id);
      const clock = await this.clock(tx, run.id);
      assertCurrentPricing(askPricingSchema.parse(step.pricing), new Date(clock.instant));
      if (step.state !== "reserved" || clock.month !== step.month)
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
      const step = await this.step(tx, id, runId);
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
      await tx
        .update(askBudgetMonths)
        .set({
          reservedMicroUsd: sql`${askBudgetMonths.reservedMicroUsd} - ${step.reservedMicroUsd}`,
          spentMicroUsd: sql`${askBudgetMonths.spentMicroUsd} + ${cost}`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(this.poolKey(step.month));
      await tx
        .update(askModelSteps)
        .set({
          ...metadata,
          state: "settled",
          chargedMicroUsd: cost,
          completedAt: sql`clock_timestamp()`,
        })
        .where(eq(askModelSteps.id, id));
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
        const step = await this.step(tx, candidate.id);
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
    return {
      checkActive: async () => {
        const state = await this.store.leaseState(run.id, run.leaseToken!);
        if (state === "cancelling") throw new AskFailure("ASK_CANCELLED", 409);
        if (state !== "running") throw new AskFailure("ASK_INTERRUPTED");
      },
      beforeModelStep: async ({ input, outputTokens, signal }) => {
        assertCurrentPricing(this.configured.pricing);
        const count = await new BedrockAdapter(this.settings, this.fetchImpl).countTokens(
          input,
          this.configured.counter,
          signal,
        );
        // Counter overhead can differ between API representations. The paid
        // request also has a hard byte/output cap; retain a conservative margin.
        const bound = count + Math.max(128, Math.ceil(count * 0.05));
        return this.reserve(run, bound, outputTokens);
      },
      modelDispatched: (id) => this.dispatched(run, id),
      recordUsage: (id, usage, receipt) => this.usage(run.id, id, usage, receipt),
      recordTool: async (tool) => {
        await this.db.transaction(async (tx) => {
          // Audit a read that was already attempted, including cancellation or
          // revocation during it. This grants no further external work and
          // cannot resurrect a terminal/deleted run's retained content.
          const [present] = await tx
            .select({ id: askRuns.id })
            .from(askRuns)
            .where(
              and(
                eq(askRuns.id, run.id),
                eq(askRuns.customerId, this.settings.customerId),
                eq(askRuns.leaseToken, run.leaseToken!),
                sql`${askRuns.expiresAt} > clock_timestamp()`,
              ),
            )
            .for("update");
          if (!present) return;
          await tx.insert(askToolEvents).values({
            runId: run.id,
            customerId: this.settings.customerId,
            sourceId: tool.sourceId,
            operationId: tool.operationId,
            parameters: tool.parameters,
            evidence: tool.evidence,
            ok: tool.ok ? "success" : "unavailable",
            latencyMs: tool.latencyMs,
          });
        });
      },
    };
  }
}
