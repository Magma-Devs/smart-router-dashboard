import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { askRuns, users, type AskRunRow } from "@sr/db";
import { eq } from "drizzle-orm";
import type { AskAnswer } from "@sr/shared";
import { readAskSettings } from "../config.js";
import { AskStore } from "../services/ask/store.js";
import { AskWorker } from "../services/ask/worker.js";
import { AskOrchestrator, type AskExecutionHooks } from "../services/ask/orchestrator.js";
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
    ASK_DATA_CUSTOMER_ID: "gk8",
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
  store = new AskStore(t.db, "gk8", 90);
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
function worker(options: { enabled?: () => boolean } = {}) {
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

describe("durable run worker scheduling and cancellation", () => {
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

  it("a lost lease interrupts instead of replaying and recovery releases the person's slot", async () => {
    const run = await submit();
    const waiting = pendingAnswer();
    const { instance } = worker();
    await instance.tick();
    await vi.waitFor(() => expect(waiting.started).toHaveBeenCalled());
    await t.db
      .update(askRuns)
      .set({ leaseUntil: new Date(0) })
      .where(eq(askRuns.id, run.id));
    await instance.drained();
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
