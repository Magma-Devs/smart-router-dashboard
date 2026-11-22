import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import {
  askBudgetMonths,
  askChats,
  askMaintenance,
  askMessages,
  askModelSteps,
  askRuns,
  askStaffAccess,
  askToolEvents,
  users,
  type AskRunRow,
} from "@sr/db";
import { and, eq, sql } from "drizzle-orm";
import { readAskSettings } from "../config.js";
import { AskBudget } from "../services/ask/budget.js";
import { AskStore } from "../services/ask/store.js";
import { AskRetention } from "../services/ask/retention.js";
import { askErrorFields } from "../services/ask/log-fields.js";
import { BedrockAdapter } from "../services/ask/bedrock.js";
import { createSession } from "../services/sessions.js";
import {
  ASK_INPUT_TOKEN_OVERHEAD,
  maximumStepCost,
  type AskBillingSettings,
} from "../services/ask/pricing.js";

const settings = readAskSettings({
  AUTH_MODE: "enabled",
  DEPLOYMENT_MODE: "managed",
  ASK_DATA_ENABLED: "true",
  ASK_DATA_CUSTOMER_ID: "customer-a",
  ASK_DATA_MCP_TOKEN: "synthetic-mcp-key",
  AWS_BEARER_TOKEN_BEDROCK: "synthetic-bedrock-key",
  ASK_DATA_BEDROCK_MODEL: "anthropic.fixture",
});
const pricing = {
  version: "fixture-only",
  model: "anthropic.fixture",
  region: "us-east-1",
  validFrom: "2026-01-01T00:00:00Z",
  validUntil: "2030-01-01T00:00:00Z",
  source: "https://aws.amazon.com/bedrock/pricing/",
  input: "1000000",
  output: "2000000",
  cacheRead: "100000",
  cacheWrite5m: "1250000",
  cacheWrite1h: "2000000",
};
const billing = (limit = 1000n): AskBillingSettings => ({
  pricing,
  monthlyLimitMicroUsd: limit,
  counter: { mode: "runtime", model: "anthropic.fixture" },
});
const receipt = { requestId: "fixture-request", providerStatus: 200 };
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
let t: TestDb;
let budget: AskBudget;
let store: AskStore;

async function running(customer = "customer-a", limit = 1000n): Promise<AskRunRow> {
  const scoped = new AskStore(t.db, customer, 90);
  const accounting = new AskBudget(t.db, { ...settings, customerId: customer }, billing(limit));
  const [person] = await t.db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.test`, ...enrolledTwoFactor() })
    .returning();
  const session = await createSession(t.db, {
    userId: person!.id,
    authMethod: "password",
    client: { ip: "127.0.0.1", userAgent: "Budget fixture" },
  });
  const chat = await scoped.createChat(person!.id);
  await scoped.submit(
    person!.id,
    session.id,
    chat.id,
    { idempotencyKey: crypto.randomUUID(), question: "Synthetic question" },
    accounting.admit,
  );
  return (await scoped.claim(60_000))!;
}
beforeEach(async () => {
  t = await createTestDb();
  store = new AskStore(t.db, "customer-a", 90);
  budget = new AskBudget(t.db, settings, billing());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});
const pool = async () =>
  (
    await t.db.select().from(askBudgetMonths).where(eq(askBudgetMonths.customerId, "customer-a"))
  )[0]!;

describe("durable shared customer spending", () => {
  it("the dispatch check right after a reservation reuses it, and a cancel in between still stops the paid request", async () => {
    const run = await running("customer-a", 1_000_000n);
    const leaseState = vi.spyOn(AskStore.prototype, "leaseState");
    const hooks = new AskBudget(t.db, settings, billing(1_000_000n)).hooks(run);
    const step = await hooks.beforeModelStep({
      input: { system: "Fixture", messages: [] },
      inputBytes: 10,
      outputTokens: 10,
    });
    await hooks.checkActive();
    expect(leaseState).not.toHaveBeenCalled();
    await hooks.checkActive();
    expect(leaseState).toHaveBeenCalledOnce();
    const next = await hooks.beforeModelStep({
      input: { system: "Fixture", messages: [] },
      inputBytes: 10,
      outputTokens: 10,
    });
    await t.db.update(askRuns).set({ status: "cancelling" }).where(eq(askRuns.id, run.id));
    await hooks.checkActive();
    await expect(hooks.modelDispatched(next)).rejects.toMatchObject({ code: "ASK_INTERRUPTED" });
    expect(step).not.toBe(next);
  });

  it("a reservation's dispatch check expires after a second", async () => {
    const run = await running("customer-a", 1_000_000n);
    const leaseState = vi.spyOn(AskStore.prototype, "leaseState");
    const hooks = new AskBudget(t.db, settings, billing(1_000_000n)).hooks(run);
    await hooks.beforeModelStep({
      input: { system: "Fixture", messages: [] },
      inputBytes: 10,
      outputTokens: 10,
    });
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + 1000);
    await hooks.checkActive();
    expect(leaseState).toHaveBeenCalledOnce();
  });

  it("writes a tool event in one statement, and none for a run whose lease is gone", async () => {
    const run = await running();
    const hooks = budget.hooks(run);
    const tool = {
      sourceId: "customer-a-metrics",
      operationId: "metrics.query",
      parameters: { query: "up" },
      ok: true,
      latencyMs: 3,
      evidence: { id: crypto.randomUUID() } as never,
    };
    await hooks.recordTool(tool);
    const [event] = await t.db.select().from(askToolEvents);
    expect(event).toMatchObject({
      runId: run.id,
      sourceId: "customer-a-metrics",
      parameters: { query: "up" },
      ok: "success",
      latencyMs: 3,
    });
    await t.db
      .update(askRuns)
      .set({ leaseToken: crypto.randomUUID() })
      .where(eq(askRuns.id, run.id));
    await hooks.recordTool({ ...tool, ok: false });
    expect(await t.db.select().from(askToolEvents)).toHaveLength(1);
  });

  it("refuses an admission whose run was already stopped, reserving nothing", async () => {
    const run = await running();
    const controller = new AbortController();
    controller.abort(new Error("Stopped fixture"));
    await expect(
      budget.hooks(run).beforeModelStep({
        input: { system: "Fixture", messages: [] },
        inputBytes: 10,
        outputTokens: 10,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Stopped fixture");
    expect(await t.db.select().from(askModelSteps)).toHaveLength(0);
    expect((await pool()).reservedMicroUsd).toBe(0n);
  });

  it("shares one atomic pool across people and Ask/Investigate entry points", async () => {
    const alice = await running();
    const bob = await running();
    const first = await budget.reserve(alice, 200, 50, "ask"); // 500 microUSD
    const second = await budget.reserve(bob, 200, 50, "investigate");
    expect((await pool()).reservedMicroUsd).toBe(1000n);
    await expect(budget.reserve(alice, 1, 1)).rejects.toMatchObject({ code: "ASK_BUDGET_BUSY" });
    await budget.dispatched(alice, first);
    await budget.usage(alice.id, first, usage, receipt);
    expect(await pool()).toMatchObject({ reservedMicroUsd: 500n, spentMicroUsd: 20n });
    await budget.dispatched(bob, second);
    await budget.usage(bob.id, second, usage, receipt);
    await budget.usage(bob.id, second, usage, receipt);
    expect(await pool()).toMatchObject({ reservedMicroUsd: 0n, spentMicroUsd: 40n });
  });
  it("retains dispatched uncertainty after Stop and settles a late usage receipt once", async () => {
    const run = await running();
    const id = await budget.reserve(run, 100, 50);
    await budget.dispatched(run, id);
    await budget.usage(run.id, id, null, { requestId: null, providerStatus: null });
    await store.cancel(run.ownerId, run.id);
    await store.fail(run.id, run.leaseToken!, "ASK_CANCELLED");
    await budget.reconcile(run.id);
    expect(await pool()).toMatchObject({ reservedMicroUsd: 300n, spentMicroUsd: 0n });
    await budget.usage(run.id, id, usage, receipt);
    await budget.reconcile();
    expect(await pool()).toMatchObject({ reservedMicroUsd: 0n, spentMicroUsd: 20n });
    expect((await t.db.select().from(askModelSteps))[0]).toMatchObject({
      state: "settled",
      providerRequestId: receipt.requestId,
    });
  });
  it("releases only never-dispatched terminal reservations, idempotently", async () => {
    const run = await running();
    const id = await budget.reserve(run, 100, 50);
    await store.fail(run.id, run.leaseToken!, "ASK_INTERRUPTED");
    await budget.reconcile();
    await budget.reconcile();
    expect(await pool()).toMatchObject({ reservedMicroUsd: 0n, spentMicroUsd: 0n });
    expect((await t.db.select().from(askModelSteps))[0]).toMatchObject({
      id,
      state: "released",
      chargedMicroUsd: 0n,
    });
    await expect(budget.dispatched(run, id)).rejects.toMatchObject({ code: "ASK_INTERRUPTED" });
  });
  it("keeps crash-after-dispatch reserved without any automatic paid retry", async () => {
    const run = await running();
    const id = await budget.reserve(run, 100, 50);
    await budget.dispatched(run, id);
    await t.db
      .update(askRuns)
      .set({ leaseUntil: new Date(0) })
      .where(eq(askRuns.id, run.id));
    await store.recover(120_000);
    await budget.reconcile();
    expect((await pool()).reservedMicroUsd).toBe(300n);
    expect((await t.db.select().from(askModelSteps))[0]?.state).toBe("uncertain");
    expect(await store.claim(1000)).toBeNull();
  });
  it("accounts cached tokens separately with the reserved price version", async () => {
    const run = await running();
    const id = await budget.reserve(run, 100, 50);
    await budget.dispatched(run, id);
    const changed = new AskBudget(t.db, settings, {
      ...billing(),
      pricing: { ...pricing, input: "999000000", version: "later-price" },
    });
    await changed.usage(
      run.id,
      id,
      {
        ...usage,
        inputTokens: 10,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 30,
        cacheDetails: [
          { ttl: "5m", inputTokens: 20 },
          { ttl: "1h", inputTokens: 10 },
        ],
      },
      receipt,
    );
    expect((await pool()).spentMicroUsd).toBe(67n); // ceil(10+10+2+25+20)
  });
  it("keeps missing cache TTL details uncertain rather than releasing their cost", async () => {
    const run = await running();
    const id = await budget.reserve(run, 100, 50);
    await budget.dispatched(run, id);
    await budget.usage(run.id, id, { ...usage, cacheWriteInputTokens: 20 }, receipt);
    expect(await pool()).toMatchObject({ reservedMicroUsd: 300n, spentMicroUsd: 0n });
  });
  it("records a provider bound violation before halting, without losing real spending", async () => {
    const run = await running();
    const id = await budget.reserve(run, 1, 1);
    await budget.dispatched(run, id);
    await expect(budget.usage(run.id, id, usage, receipt)).rejects.toMatchObject({
      code: "ASK_LIMIT_REACHED",
    });
    expect(await pool()).toMatchObject({ spentMicroUsd: 20n, reservedMicroUsd: 0n });
  });
  it("rejects foreign run/step IDs and stale or cancelled leases before dispatch", async () => {
    const own = await running();
    const foreign = await running("customer-b");
    await expect(budget.reserve(foreign, 10, 10)).rejects.toMatchObject({
      code: "ASK_INTERRUPTED",
    });
    const id = await budget.reserve(own, 10, 10);
    const foreignBudget = new AskBudget(t.db, { ...settings, customerId: "customer-b" }, billing());
    await expect(foreignBudget.usage(own.id, id, usage, receipt)).rejects.toMatchObject({
      code: "ASK_NOT_FOUND",
    });
    await store.cancel(own.ownerId, own.id);
    await expect(budget.dispatched(own, id)).rejects.toMatchObject({ code: "ASK_INTERRUPTED" });
  });
  it("blocks an expired price before a paid dispatch", async () => {
    const run = await running();
    const id = await budget.reserve(run, 10, 10);
    await t.db
      .update(askModelSteps)
      .set({ pricing: { ...pricing, validUntil: "2026-01-02T00:00:00Z" } })
      .where(eq(askModelSteps.id, id));
    await expect(budget.dispatched(run, id)).rejects.toMatchObject({ code: "ASK_UNAVAILABLE" });
  });
  it("does not dispatch a reservation across a UTC month boundary", async () => {
    const run = await running();
    const id = await budget.reserve(run, 10, 10);
    await t.db.insert(askBudgetMonths).values({
      customerId: "customer-a",
      month: "2020-01",
      limitMicroUsd: 1000n,
      reservedMicroUsd: 40n,
    });
    await t.db
      .update(askBudgetMonths)
      .set({ reservedMicroUsd: 0n })
      .where(
        and(
          eq(askBudgetMonths.customerId, "customer-a"),
          sql`${askBudgetMonths.month} <> '2020-01'`,
        ),
      );
    await t.db.update(askModelSteps).set({ month: "2020-01" }).where(eq(askModelSteps.id, id));
    await expect(budget.dispatched(run, id)).rejects.toMatchObject({ code: "ASK_INTERRUPTED" });
    await store.fail(run.id, run.leaseToken!, "ASK_INTERRUPTED");
    await budget.reconcile();
    expect(
      (await t.db.select().from(askBudgetMonths)).every((p) => p.reservedMicroUsd === 0n),
    ).toBe(true);
  });
  it("reserves the request's byte bound before dispatch, with no network call", async () => {
    const run = await running("customer-a", 1_000_000n);
    const counter = vi.spyOn(BedrockAdapter.prototype, "countTokens");
    const network = vi.spyOn(globalThis, "fetch");
    const hooks = new AskBudget(t.db, settings, billing(1_000_000n)).hooks(run);
    const input = {
      system: "Fixture",
      messages: [{ role: "user" as const, content: [{ text: "x".repeat(30_000) }] }],
    };
    const id = await hooks.beforeModelStep({ input, inputBytes: 0, outputTokens: 10 });
    const bound = Buffer.byteLength(JSON.stringify(input)) + ASK_INPUT_TOKEN_OVERHEAD;
    expect(counter).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect((await t.db.select().from(askModelSteps))[0]).toMatchObject({
      id,
      state: "reserved",
      inputTokenBound: bound,
      reservedMicroUsd: maximumStepCost(pricing, bound, 10),
    });
    await hooks.modelDispatched(id);
    expect((await t.db.select().from(askModelSteps))[0]?.state).toBe("dispatched");
    await expect(hooks.modelDispatched(id)).rejects.toMatchObject({ code: "ASK_INTERRUPTED" });
  });
  it("settles a real cost below the byte bound and frees the whole reservation", async () => {
    const run = await running("customer-a", 1_000_000n);
    const accounting = new AskBudget(t.db, settings, billing(1_000_000n));
    const hooks = accounting.hooks(run);
    const input = {
      system: "Fixture",
      messages: [{ role: "user" as const, content: [{ text: "x".repeat(30_000) }] }],
    };
    const id = await hooks.beforeModelStep({ input, inputBytes: 0, outputTokens: 2048 });
    const reserved = (await pool()).reservedMicroUsd;
    expect(reserved).toBeGreaterThan(9000n);
    await hooks.modelDispatched(id);
    await hooks.recordUsage(
      id,
      { inputTokens: 8000, outputTokens: 500, totalTokens: 8500 },
      receipt,
    );
    // 8000 x 1 + 500 x 2 microUSD at the fixture rates.
    expect(await pool()).toMatchObject({ reservedMicroUsd: 0n, spentMicroUsd: 9000n });
    expect((await t.db.select().from(askModelSteps))[0]).toMatchObject({
      state: "settled",
      chargedMicroUsd: 9000n,
    });
  });
  it("refuses a turn whose byte bound would pass the monthly limit, reserving nothing", async () => {
    const run = await running();
    const input = {
      system: "Fixture",
      messages: [{ role: "user" as const, content: [{ text: "x".repeat(30_000) }] }],
    };
    await expect(
      budget.hooks(run).beforeModelStep({ input, inputBytes: 0, outputTokens: 10 }),
    ).rejects.toMatchObject({ code: "ASK_BUDGET_LIMIT" });
    expect(await t.db.select().from(askModelSteps)).toHaveLength(0);
    const after = await pool();
    expect(after.spentMicroUsd + after.reservedMicroUsd).toBeLessThanOrEqual(after.limitMicroUsd);
  });
});

describe("physical content retention without financial reset", () => {
  it("deletes old content/tools/preferences and staff access, preserving spend and another customer's open question", async () => {
    const run = await running();
    const other = await running("customer-b");
    const id = await budget.reserve(run, 100, 50);
    await budget.dispatched(run, id);
    await budget.usage(run.id, id, usage, receipt);
    await store.savePreferences(run.ownerId, {
      view: "full",
      chatId: run.chatId,
      returnTo: "/metrics",
    });
    await t.db.insert(askToolEvents).values({
      runId: run.id,
      customerId: "customer-a",
      sourceId: "fixture",
      operationId: "metrics.query",
      parameters: { query: "private-fixture" },
      evidence: {},
      ok: "success",
      latencyMs: 1,
    });
    await t.db.insert(askStaffAccess).values({
      customerId: "customer-a",
      subject: "staff-fixture",
      action: "read",
      createdAt: new Date(0),
    });
    await store.fail(run.id, run.leaseToken!, "ASK_INTERRUPTED");
    await t.db
      .update(askRuns)
      .set({ createdAt: new Date(0), expiresAt: new Date(0) })
      .where(eq(askRuns.id, run.id));
    await t.db
      .update(askChats)
      .set({ updatedAt: new Date(0), expiresAt: new Date(0) })
      .where(eq(askChats.id, run.chatId));
    const retention = new AskRetention(t.db, "customer-a", 30);
    expect(await retention.sweep(0)).toBe(1);
    expect(await retention.sweep(0)).toBe(0);
    expect(await t.db.select().from(askToolEvents)).toHaveLength(0);
    expect(await t.db.select().from(askStaffAccess)).toHaveLength(0);
    expect(await t.db.select().from(askMessages)).toHaveLength(1); // other customer only
    expect((await store.preferences(run.ownerId)).chatId).toBeNull();
    expect(await pool()).toMatchObject({ spentMicroUsd: 20n, reservedMicroUsd: 0n });
    expect((await t.db.select().from(askModelSteps))[0]?.state).toBe("settled");
    expect(
      (await new AskStore(t.db, "customer-b", 90).getRun(other.ownerId, other.id)).status,
    ).toBe("running");
    expect((await t.db.select().from(askMaintenance))[0]).toMatchObject({ errorCode: null });
  });
  it("continues maintenance with missing billing configuration and retains uncertainty", async () => {
    const run = await running();
    const id = await budget.reserve(run, 100, 50);
    await budget.dispatched(run, id);
    await store.fail(run.id, run.leaseToken!, "ASK_INTERRUPTED");
    await new AskBudget(t.db, settings, null).reconcile();
    expect((await t.db.select().from(askModelSteps))[0]?.state).toBe("uncertain");
    expect((await pool()).reservedMicroUsd).toBe(300n);
  });
  it("records a failed retention attempt safely and retries without losing the last success", async () => {
    const retention = new AskRetention(t.db, "customer-a", 30);
    const driver = Object.assign(new Error("private-prompt-driver-error"), { code: "57P01" });
    const failure = vi.spyOn(t.db, "transaction").mockRejectedValueOnce(driver);
    const refused = await retention.sweep(0).catch((error: unknown) => error);
    expect(refused).toMatchObject({ message: "ASK_RETENTION_FAILED", cause: driver });
    expect(askErrorFields(refused)).toEqual({
      errorClass: "Error",
      causeClass: "Error",
      errorCode: "57P01",
    });
    expect((await t.db.select().from(askMaintenance))[0]).toMatchObject({
      errorCode: "ASK_RETENTION_FAILED",
      lastSuccessAt: null,
    });
    failure.mockRestore();
    await retention.sweep(0);
    expect((await t.db.select().from(askMaintenance))[0]).toMatchObject({
      errorCode: null,
      lastSuccessAt: expect.any(Date),
    });
  });
});
