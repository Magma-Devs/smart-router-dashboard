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
import { BedrockAdapter } from "../services/ask/bedrock.js";
import { createSession } from "../services/sessions.js";
import type { AskBillingSettings } from "../services/ask/pricing.js";

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

async function running(customer = "customer-a"): Promise<AskRunRow> {
  const scoped = new AskStore(t.db, customer, 90);
  const accounting = new AskBudget(t.db, { ...settings, customerId: customer }, billing());
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
  it("requires a successful free count and reservation before dispatch", async () => {
    const run = await running();
    const counter = vi
      .spyOn(BedrockAdapter.prototype, "countTokens")
      .mockRejectedValueOnce(new Error("denied"));
    const hooks = budget.hooks(run);
    await expect(
      hooks.beforeModelStep({
        input: { system: "Fixture", messages: [] },
        inputBytes: 100,
        outputTokens: 10,
      }),
    ).rejects.toThrow();
    expect(await t.db.select().from(askModelSteps)).toHaveLength(0);
    counter.mockResolvedValue(100);
    const id = await hooks.beforeModelStep({
      input: { system: "Fixture", messages: [] },
      inputBytes: 100,
      outputTokens: 10,
    });
    expect((await t.db.select().from(askModelSteps))[0]).toMatchObject({
      id,
      state: "reserved",
      inputTokenBound: 228,
    });
    await hooks.modelDispatched(id);
    expect((await t.db.select().from(askModelSteps))[0]?.state).toBe("dispatched");
    await expect(hooks.modelDispatched(id)).rejects.toMatchObject({ code: "ASK_INTERRUPTED" });
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
    const failure = vi
      .spyOn(t.db, "transaction")
      .mockRejectedValueOnce(new Error("private-prompt-driver-error"));
    await expect(retention.sweep(0)).rejects.toThrow("ASK_RETENTION_FAILED");
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
