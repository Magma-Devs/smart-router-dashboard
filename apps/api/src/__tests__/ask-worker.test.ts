import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { askRuns, users, type AskRunRow } from "@sr/db";
import { eq } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import type { AskAnswer } from "@sr/shared";
import { readAskSettings } from "../config.js";
import { AskStore } from "../services/ask/store.js";
import { AskWorker } from "../services/ask/worker.js";
import { AskOrchestrator, type AskExecutionHooks } from "../services/ask/orchestrator.js";
import { AskFailure } from "../services/ask/errors.js";
import { createSession } from "../services/sessions.js";

const answer: AskAnswer = {
  contractVersion: 1,
  summary: "Fixture answer",
  sections: [{ title: "Fixture", body: "Synthetic evidence." }],
  answeredAt: "2026-11-16T12:00:00Z",
  evidence: [],
};
const settings = () => ({
  ...readAskSettings({
    AUTH_MODE: "enabled",
    DEPLOYMENT_MODE: "managed",
    ASK_DATA_ENABLED: "true",
    ASK_DATA_CUSTOMER_ID: "acme",
    ASK_DATA_MCP_TOKEN: "customer-fixture",
    AWS_BEARER_TOKEN_BEDROCK: "provider-fixture",
    ASK_DATA_BEDROCK_MODEL: "test-model",
  }),
  heartbeatMs: 10,
  workerPollMs: 10,
  leaseMs: 1000,
  runTimeoutMs: 5000,
});
let t: TestDb;
let store: AskStore;
let owner: string;
let sessionId: string;
let chatId: string;
const workers: AskWorker[] = [];
const hooks = (): AskExecutionHooks => ({
  checkActive: vi.fn(async () => undefined),
  beforeModelStep: vi.fn(async () => crypto.randomUUID()),
  modelDispatched: vi.fn(async () => undefined),
  recordUsage: vi.fn(async () => undefined),
  recordTool: vi.fn(async () => undefined),
});

beforeEach(async () => {
  t = await createTestDb();
  store = new AskStore(t.db, "acme", 90);
  const [user] = await t.db
    .insert(users)
    .values({ email: "worker@example.test", role: "read_only", ...enrolledTwoFactor() })
    .returning();
  owner = user!.id;
  const session = await createSession(t.db, {
    userId: owner,
    authMethod: "password",
    client: { ip: "127.0.0.1", userAgent: "Worker fixture" },
  });
  sessionId = session.id;
  chatId = (await store.createChat(owner)).id;
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.restoreAllMocks();
  await t.close();
});
const submit = () =>
  store.submit(
    owner,
    sessionId,
    chatId,
    { idempotencyKey: crypto.randomUUID(), question: "Fixture question" },
    async () => undefined,
  );
function worker(
  options: {
    enabled?: () => boolean;
    canClaim?: () => boolean;
    onError?: (code: string, error?: unknown) => void;
  } = {},
) {
  const afterTerminal = vi.fn(async () => undefined);
  const instance = new AskWorker(store, settings(), { hooks, afterTerminal, ...options });
  workers.push(instance);
  return { instance, afterTerminal };
}
function pendingAnswer() {
  let release!: (answer: AskAnswer) => void;
  const started = vi.fn();
  const spy = vi
    .spyOn(AskOrchestrator.prototype, "answer")
    .mockImplementation(async (_run, _history, _hooks, signal) => {
      started();
      signal.throwIfAborted();
      return new Promise<AskAnswer>((resolve, reject) => {
        release = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
  return { spy, started, release: () => release(answer) };
}
/** Records every lease read and renewal so a test can wait for the ones the
 * heartbeat starts without awaiting, including those still running after
 * `drained()`. */
function leaseChecks() {
  const pending: Promise<unknown>[] = [];
  const leaseState = store.leaseState.bind(store);
  const renew = store.renew.bind(store);
  vi.spyOn(store, "leaseState").mockImplementation((...args) => {
    const call = leaseState(...args);
    pending.push(call.catch(() => undefined));
    return call;
  });
  vi.spyOn(store, "renew").mockImplementation((...args) => {
    const call = renew(...args);
    pending.push(call.catch(() => undefined));
    return call;
  });
  return async () => {
    for (let seen = -1; seen !== pending.length;) {
      seen = pending.length;
      await Promise.all(pending);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
}
/** Holds a terminal write open after its commit for several heartbeat periods,
 * as a slow database round trip does. */
const slowAfterCommit = <T>(call: Promise<T>) =>
  call.then((value) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 60)));

describe("durable run worker scheduling and cancellation", () => {
  it("a starting replica awaiting readiness leaves another replica's admitted question queued", async () => {
    const run = await submit();
    let ready = false;
    const { instance } = worker({ canClaim: () => ready });
    const spy = vi.spyOn(AskOrchestrator.prototype, "answer").mockResolvedValue(answer);
    await instance.tick();
    expect((await store.getRun(owner, run.id)).status).toBe("queued");
    expect(spy).not.toHaveBeenCalled();
    ready = true;
    await instance.tick();
    await instance.drained();
    expect((await store.getRun(owner, run.id)).status).toBe("succeeded");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("an unready replica cannot interrupt a healthy replica's active answer", async () => {
    const run = await submit();
    const waiting = pendingAnswer();
    const healthy = worker();
    const starting = worker({ canClaim: () => false });
    await healthy.instance.tick();
    await vi.waitFor(() => expect(waiting.started).toHaveBeenCalledOnce());
    await starting.instance.tick();
    expect((await store.getRun(owner, run.id)).status).toBe("running");
    waiting.release();
    await healthy.instance.drained();
    expect((await store.getRun(owner, run.id)).status).toBe("succeeded");
  });

  it("a queue wait consumes the same deadline as execution", async () => {
    const run = await submit();
    await t.db
      .update(askRuns)
      .set({ createdAt: new Date(Date.now() - 6000) })
      .where(eq(askRuns.id, run.id));
    const spy = vi.spyOn(AskOrchestrator.prototype, "answer").mockResolvedValue(answer);
    const { instance } = worker();
    await instance.tick();
    expect(await store.getRun(owner, run.id)).toMatchObject({
      status: "failed",
      error: { code: "ASK_TIMEOUT" },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("claims a queued run, persists one answer and reconciles terminal usage", async () => {
    const run = await submit();
    const spy = vi.spyOn(AskOrchestrator.prototype, "answer").mockResolvedValue(answer);
    const { instance, afterTerminal } = worker();
    await instance.tick();
    await instance.drained();
    expect((await store.getRun(owner, run.id)).status).toBe("succeeded");
    expect((await store.chatDetail(owner, chatId)).messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(afterTerminal).toHaveBeenCalledWith(run.id);
  });

  it("does not execute a run twice when two replicas wake", async () => {
    await submit();
    const waiting = pendingAnswer();
    const first = worker();
    const second = worker();
    await Promise.all([first.instance.tick(), second.instance.tick()]);
    await vi.waitFor(() => expect(waiting.started).toHaveBeenCalledTimes(1));
    waiting.release();
    await Promise.all([first.instance.drained(), second.instance.drained()]);
    expect(waiting.spy).toHaveBeenCalledTimes(1);
  });

  it("durably stops an active request and creates no assistant success", async () => {
    const run = await submit();
    const waiting = pendingAnswer();
    const { instance } = worker();
    await instance.tick();
    await vi.waitFor(() => expect(waiting.started).toHaveBeenCalled());
    await store.cancel(owner, run.id);
    await instance.drained();
    expect((await store.getRun(owner, run.id)).status).toBe("cancelled");
    expect((await store.chatDetail(owner, chatId)).messages).toHaveLength(1);
    expect(waiting.spy).toHaveBeenCalledTimes(1);
  });

  it("disable interrupts active and queued work without starting another provider request", async () => {
    const first = await submit();
    const waiting = pendingAnswer();
    let enabled = true;
    const { instance } = worker({ enabled: () => enabled });
    await instance.tick();
    await vi.waitFor(() => expect(waiting.started).toHaveBeenCalled());
    // A second customer's/person's queued turn is not needed to test the
    // disable sweep: create a second person in the same customer.
    const [other] = await t.db
      .insert(users)
      .values({ email: "other-worker@example.test", ...enrolledTwoFactor() })
      .returning();
    const session = await createSession(t.db, {
      userId: other!.id,
      authMethod: "password",
      client: { ip: "127.0.0.1", userAgent: "Worker fixture" },
    });
    const otherChat = await store.createChat(other!.id);
    const queued = await store.submit(
      other!.id,
      session.id,
      otherChat.id,
      { idempotencyKey: crypto.randomUUID(), question: "Queued fixture" },
      async () => undefined,
    );
    enabled = false;
    await instance.tick();
    await instance.drained();
    expect((await store.getRun(owner, first.id)).status).toBe("interrupted");
    expect((await store.getRun(other!.id, queued.id)).status).toBe("interrupted");
    expect(waiting.spy).toHaveBeenCalledTimes(1);
  });

  it("stopping during an in-flight queue claim cannot start work after shutdown", async () => {
    const submitted = await submit();
    const lease = (await store.claim(1000))!;
    let release!: (run: AskRunRow) => void;
    const claim = vi.spyOn(store, "claim").mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const spy = vi.spyOn(AskOrchestrator.prototype, "answer").mockResolvedValue(answer);
    const { instance } = worker();
    const ticking = instance.tick();
    await vi.waitFor(() => expect(claim).toHaveBeenCalled());
    const stopping = instance.stop();
    release(lease);
    await Promise.all([ticking, stopping]);
    expect(spy).not.toHaveBeenCalled();
    expect((await store.getRun(owner, submitted.id)).status).toBe("interrupted");
  });

  it("a completed run logs no lease error while its answer is persisted", async () => {
    const run = await submit();
    vi.spyOn(AskOrchestrator.prototype, "answer").mockResolvedValue(answer);
    const succeed = store.succeed.bind(store);
    vi.spyOn(store, "succeed").mockImplementation((...args) => slowAfterCommit(succeed(...args)));
    const settled = leaseChecks();
    const onError = vi.fn();
    const { instance } = worker({ onError });
    await instance.tick();
    await instance.drained();
    await settled();
    expect((await store.getRun(owner, run.id)).status).toBe("succeeded");
    expect(onError).not.toHaveBeenCalled();
  });

  it("a failed run logs no lease error while its failure is persisted", async () => {
    const run = await submit();
    vi.spyOn(AskOrchestrator.prototype, "answer").mockRejectedValue(
      new AskFailure("ASK_UNAVAILABLE"),
    );
    const fail = store.fail.bind(store);
    vi.spyOn(store, "fail").mockImplementation((...args) => slowAfterCommit(fail(...args)));
    const settled = leaseChecks();
    const onError = vi.fn();
    const { instance } = worker({ onError });
    await instance.tick();
    await instance.drained();
    await settled();
    expect(await store.getRun(owner, run.id)).toMatchObject({
      status: "failed",
      error: { code: "ASK_UNAVAILABLE" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("a lease lost while the answer is persisted is reported and publishes no answer", async () => {
    const run = await submit();
    vi.spyOn(AskOrchestrator.prototype, "answer").mockResolvedValue(answer);
    const succeed = store.succeed.bind(store);
    vi.spyOn(store, "succeed").mockImplementation(async (...args) => {
      await t.db
        .update(askRuns)
        .set({ leaseUntil: new Date(0) })
        .where(eq(askRuns.id, run.id));
      return succeed(...args);
    });
    const settled = leaseChecks();
    const onError = vi.fn();
    const { instance } = worker({ onError });
    await instance.tick();
    await instance.drained();
    await settled();
    expect((await store.getRun(owner, run.id)).status).toBe("interrupted");
    expect((await store.chatDetail(owner, chatId)).messages).toHaveLength(1);
    expect(onError.mock.calls).toEqual([["ASK_LEASE_LOST"]]);
  });

  it("a failed lease check hands its error to the log and interrupts the run", async () => {
    const run = await submit();
    pendingAnswer();
    const failure = new DrizzleQueryError("select status from ask_runs", [], new Error("refused"));
    vi.spyOn(store, "renew").mockRejectedValue(failure);
    const onError = vi.fn();
    const { instance } = worker({ onError });
    await instance.tick();
    await instance.drained();
    expect(onError.mock.calls).toEqual([["ASK_LEASE_CHECK_FAILED", failure]]);
    expect((await store.getRun(owner, run.id)).status).toBe("interrupted");
  });

  it("a lost lease interrupts instead of replaying and recovery releases the person's slot", async () => {
    const run = await submit();
    const waiting = pendingAnswer();
    const onError = vi.fn();
    const { instance } = worker({ onError });
    await instance.tick();
    await vi.waitFor(() => expect(waiting.started).toHaveBeenCalled());
    await t.db
      .update(askRuns)
      .set({ leaseUntil: new Date(0) })
      .where(eq(askRuns.id, run.id));
    await instance.drained();
    expect(onError).toHaveBeenCalledWith("ASK_LEASE_LOST");
    const signal = waiting.spy.mock.calls[0]![3];
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ code: "ASK_INTERRUPTED" });
    await instance.tick();
    expect((await store.getRun(owner, run.id)).status).toBe("interrupted");
    expect(waiting.spy).toHaveBeenCalledTimes(1);
    expect(await store.activeRun(owner)).toBeNull();
  });

  it("rejects malformed success from an execution dependency before writing an assistant message", async () => {
    const run = await submit();
    vi.spyOn(AskOrchestrator.prototype, "answer").mockResolvedValue({ ...answer, summary: "" });
    const { instance } = worker();
    await instance.tick();
    await instance.drained();
    expect(await store.getRun(owner, run.id)).toMatchObject({
      status: "failed",
      answer: null,
      error: { code: "ASK_INVALID_ANSWER" },
    });
    expect((await store.chatDetail(owner, chatId)).messages).toHaveLength(1);
  });

  it("a saved run is claimed when its replica wakes the worker, not at the next poll", async () => {
    const spy = vi.spyOn(AskOrchestrator.prototype, "answer").mockResolvedValue(answer);
    const instance = new AskWorker(
      store,
      { ...settings(), workerPollMs: 60_000 },
      { hooks, afterTerminal: vi.fn(async () => undefined) },
    );
    workers.push(instance);
    instance.start();
    const run = await submit();
    instance.wake();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce(), { timeout: 2000 });
    await instance.drained();
    expect((await store.getRun(owner, run.id)).status).toBe("succeeded");
  });

  it("a wake during a tick runs one more tick when that one ends", async () => {
    const spy = vi.spyOn(AskOrchestrator.prototype, "answer").mockResolvedValue(answer);
    let release!: () => void;
    const claim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return null;
    }).mockImplementation(claim);
    const instance = new AskWorker(
      store,
      { ...settings(), workerPollMs: 60_000 },
      { hooks, afterTerminal: vi.fn(async () => undefined) },
    );
    workers.push(instance);
    instance.start();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const run = await submit();
    instance.wake();
    release();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce(), { timeout: 2000 });
    await instance.drained();
    expect((await store.getRun(owner, run.id)).status).toBe("succeeded");
  });

  it("claims a run in one statement and a run past its deadline not at all", async () => {
    const run = await submit();
    await t.db
      .update(askRuns)
      .set({ createdAt: new Date(Date.now() - 6000) })
      .where(eq(askRuns.id, run.id));
    expect(await store.claim(1000, 5000)).toBeNull();
    expect((await store.getRun(owner, run.id)).status).toBe("queued");
    const claimed = await store.claim(1000);
    expect(claimed).toMatchObject({ id: run.id, status: "running", attempts: 1 });
    expect(await store.claim(1000)).toBeNull();
  });

  it("a lease renewal extends a running run, reads a cancelling one without extending it, and loses a revoked one", async () => {
    await submit();
    const run = (await store.claim(1000))!;
    const until = async () =>
      (await t.db.select().from(askRuns).where(eq(askRuns.id, run.id)))[0]!.leaseUntil!.getTime();
    const before = await until();
    expect(await store.renew(run.id, run.leaseToken!, 60_000)).toBe("running");
    const extended = await until();
    expect(extended).toBeGreaterThan(before + 30_000);
    await t.db.update(askRuns).set({ status: "cancelling" }).where(eq(askRuns.id, run.id));
    expect(await store.renew(run.id, run.leaseToken!, 120_000)).toBe("cancelling");
    expect(await until()).toBe(extended);
    expect(await store.renew(run.id, crypto.randomUUID(), 60_000)).toBe("lost");
    await t.db.update(askRuns).set({ status: "running" }).where(eq(askRuns.id, run.id));
    await t.db.update(users).set({ status: "suspended" }).where(eq(users.id, owner));
    expect(await store.renew(run.id, run.leaseToken!, 60_000)).toBe("lost");
  });

  it("passes only retained earlier personal turns as history", async () => {
    const old = await submit();
    await store.cancel(owner, old.id);
    const current = await submit();
    const spy = vi.spyOn(AskOrchestrator.prototype, "answer").mockResolvedValue(answer);
    const { instance } = worker();
    await instance.tick();
    await instance.drained();
    const history = spy.mock.calls[0]![1];
    expect(history).toHaveLength(1);
    expect(history[0]!.runId).toBe(old.id);
    expect(history.some((message) => message.runId === current.id)).toBe(false);
  });
});
