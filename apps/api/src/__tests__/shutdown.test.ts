import { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { askRuns, users } from "@sr/db";
import { eq } from "drizzle-orm";
import type { AskAnswer } from "@sr/shared";
import { config, readAskSettings } from "../config.js";
import { createSession } from "../services/sessions.js";
import { installAskRuntime } from "../services/ask/runtime.js";
import { AskOrchestrator } from "../services/ask/orchestrator.js";
import { AskStore } from "../services/ask/store.js";
import { AskWorker } from "../services/ask/worker.js";
import {
  createShutdown,
  drainRemainingMs,
  onStopSignals,
  SHUTDOWN_CLOSE_RESERVE_MS,
  type Shutdown,
} from "../shutdown.js";

/**
 * The api's stop sequence on SIGTERM / SIGINT (MAG-5660).
 *
 * These pin the order — stopping, no new claims, the running answer finished
 * or its lease ended, the pool closed, exit 0 — and the bounds around it: the
 * drain window, the hard deadline and a second signal.
 */

const answer: AskAnswer = {
  contractVersion: 1,
  summary: "Fixture answer",
  sections: [{ title: "Fixture", body: "Synthetic evidence." }],
  answeredAt: "2026-11-22T12:00:00Z",
  evidence: [],
};

const apps: FastifyInstance[] = [];
/** Close hooks a test holds open; released before its apps close. */
const held: (() => void)[] = [];
const hold = () =>
  new Promise<void>((resolve) => {
    held.push(resolve);
  });
afterEach(async () => {
  for (const release of held.splice(0)) release();
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A bare app with the `stopping` decoration buildApp gives the real one. */
function bareApp(): FastifyInstance {
  const app = Fastify();
  app.decorate("stopping", null);
  apps.push(app);
  return app;
}

function exits() {
  const codes: number[] = [];
  let reached!: (code: number) => void;
  const first = new Promise<number>((resolve) => {
    reached = resolve;
  });
  return {
    codes,
    first,
    exit: (code: number) => {
      codes.push(code);
      reached(code);
    },
  };
}

describe("the stop sequence", () => {
  it("fits the deadline inside the pod's 30 s grace period, the drain inside the deadline", () => {
    expect(config.server.shutdownTimeoutMs).toBe(20_000);
    expect(config.server.shutdownTimeoutMs).toBeLessThan(30_000);
    // The reserve covers the interrupted runs' terminal writes and the pool's
    // own 5 s end.
    expect(SHUTDOWN_CLOSE_RESERVE_MS).toBeGreaterThan(5_000);
    expect(config.server.shutdownTimeoutMs - SHUTDOWN_CLOSE_RESERVE_MS).toBe(12_000);
  });

  it("marks the app stopping before any close hook runs, then exits 0", async () => {
    const app = bareApp();
    const events: string[] = [];
    app.addHook("preClose", async () => {
      events.push(app.stopping ? "stopping" : "serving");
    });
    app.addHook("onClose", async () => {
      events.push("closed");
    });
    await app.ready();
    const { exit, first, codes } = exits();
    const shutdown = createShutdown({ timeoutMs: 10_000, exit, log: () => undefined });
    expect(shutdown.attach(app)).toBe(true);
    const at = Date.now();
    shutdown.signal("SIGTERM");
    expect(app.stopping).toMatchObject({ signal: "SIGTERM" });
    expect(drainRemainingMs(app, at)).toBeGreaterThan(0);
    expect(await first).toBe(0);
    expect(events).toEqual(["stopping", "closed"]);
    expect(codes).toEqual([0]);
  });

  it("a second signal exits 1 while the first close is still running", async () => {
    const app = bareApp();
    app.addHook("onClose", hold);
    await app.ready();
    const { exit, first, codes } = exits();
    const shutdown = createShutdown({ timeoutMs: 10_000, exit, log: () => undefined });
    shutdown.attach(app);
    shutdown.signal("SIGTERM");
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const second = Date.now();
    shutdown.signal("SIGTERM");
    expect(await first).toBe(1);
    expect(Date.now() - second).toBeLessThan(1_000);
    expect(codes).toEqual([1]);
  });

  it("a close that hangs past the deadline exits 1", async () => {
    const app = bareApp();
    app.addHook("onClose", hold);
    await app.ready();
    const { exit, first } = exits();
    const shutdown = createShutdown({ timeoutMs: 200, exit, log: () => undefined });
    shutdown.attach(app);
    const started = Date.now();
    shutdown.signal("SIGTERM");
    expect(await first).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("closes a request still open when the drain window ends, and exits 0 before the deadline", async () => {
    const app = bareApp();
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.get("/hang", () => {
      entered();
      return new Promise(() => undefined);
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const hanging = fetch(`http://127.0.0.1:${port}/hang`).catch(() => "cut");
    await inside;
    const { exit, first } = exits();
    // A 300 ms drain window; the deadline is 8 s past it.
    const shutdown = createShutdown({
      timeoutMs: SHUTDOWN_CLOSE_RESERVE_MS + 300,
      exit,
      log: () => undefined,
    });
    shutdown.attach(app);
    const started = Date.now();
    shutdown.signal("SIGTERM");
    expect(await first).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await hanging).toBe("cut");
  });

  it("a signal before the app is built closes it on attach", async () => {
    const { exit, first } = exits();
    const shutdown = createShutdown({ timeoutMs: 10_000, exit, log: () => undefined });
    shutdown.signal("SIGINT");
    expect(shutdown.stopping).toBe(true);
    const app = bareApp();
    await app.ready();
    expect(shutdown.attach(app)).toBe(false);
    expect(await first).toBe(0);
    expect(app.stopping).toMatchObject({ signal: "SIGINT" });
  });

  it("routes SIGTERM and SIGINT to the sequence, and the remover unhooks both", () => {
    const source = new EventEmitter();
    const seen: string[] = [];
    const shutdown = { signal: (name: string) => seen.push(name) } as unknown as Shutdown;
    const remove = onStopSignals(shutdown, source as unknown as NodeJS.Process);
    source.emit("SIGTERM");
    source.emit("SIGINT");
    expect(seen).toEqual(["SIGTERM", "SIGINT"]);
    remove();
    expect(source.listenerCount("SIGTERM") + source.listenerCount("SIGINT")).toBe(0);
  });

  it("a close with no signal leaves no drain", () => {
    const app = bareApp();
    expect(drainRemainingMs(app)).toBe(0);
    expect(drainRemainingMs(Fastify())).toBe(0);
  });
});

describe("the stop sequence with an Ask run in flight", () => {
  let t: TestDb;
  let store: AskStore;
  const people: { owner: string; sessionId: string; chatId: string }[] = [];

  beforeEach(async () => {
    for (const [key, value] of Object.entries({
      AUTH_MODE: "enabled",
      DEPLOYMENT_MODE: "managed",
      ASK_DATA_ENABLED: "true",
      ASK_DATA_CUSTOMER_ID: "customer-a",
      ASK_DATA_MCP_TOKEN: "synthetic-customer-key",
      AWS_BEARER_TOKEN_BEDROCK: "synthetic-provider-key",
      ASK_DATA_BEDROCK_MODEL: "anthropic.fixture",
      ASK_DATA_TOKEN_COUNTER: "runtime",
      ASK_DATA_PRICING_JSON: JSON.stringify({
        version: "test-only",
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
      }),
    }))
      vi.stubEnv(key, value);
    t = await createTestDb();
    store = new AskStore(t.db, "customer-a", 90);
    people.length = 0;
    for (const email of ["first@example.test", "second@example.test"]) {
      const [user] = await t.db
        .insert(users)
        .values({ email, ...enrolledTwoFactor() })
        .returning();
      const session = await createSession(t.db, {
        userId: user!.id,
        authMethod: "password",
        client: { ip: "127.0.0.1", userAgent: "Shutdown fixture" },
      });
      people.push({
        owner: user!.id,
        sessionId: session.id,
        chatId: (await store.createChat(user!.id)).id,
      });
    }
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
    await t.close();
  });

  const submit = (who: number) => {
    const person = people[who]!;
    return store.submit(
      person.owner,
      person.sessionId,
      person.chatId,
      { idempotencyKey: crypto.randomUUID(), question: "Fixture question" },
      async () => undefined,
    );
  };
  const row = async (id: string) =>
    (await t.db.select().from(askRuns).where(eq(askRuns.id, id)))[0]!;

  /** The api's shape: the database plugin is registered before the Ask
   * runtime, so its `onClose` (the pool's end) runs after the runtime's. */
  async function boot(events: string[], routes?: (app: FastifyInstance) => void) {
    const app = Fastify();
    apps.push(app);
    app.decorate("stopping", null);
    app.decorate("db", t.db);
    app.decorate("dbReady", Promise.resolve());
    app.addHook("preClose", async () => {
      events.push(app.stopping ? "stopping" : "serving");
    });
    app.addHook("onClose", async () => {
      events.push("pool-closed");
    });
    const runtime = installAskRuntime(app);
    routes?.(app);
    await app.ready();
    await vi.waitFor(() => expect(runtime.ready()).toBe(true));
    return app;
  }

  function record(events: string[]) {
    const claim = AskStore.prototype.claim;
    vi.spyOn(AskStore.prototype, "claim").mockImplementation(async function (
      this: AskStore,
      ...args
    ) {
      const run = await claim.apply(this, args);
      if (run) events.push("claim");
      return run;
    });
    const succeed = AskStore.prototype.succeed;
    vi.spyOn(AskStore.prototype, "succeed").mockImplementation(async function (
      this: AskStore,
      ...args
    ) {
      const done = await succeed.apply(this, args);
      events.push("run-succeeded");
      return done;
    });
    const fail = AskStore.prototype.fail;
    vi.spyOn(AskStore.prototype, "fail").mockImplementation(async function (
      this: AskStore,
      ...args
    ) {
      const done = await fail.apply(this, args);
      events.push(`run-failed:${args[2]}`);
      return done;
    });
  }

  function pendingAnswer() {
    let release!: () => void;
    const started = vi.fn();
    vi.spyOn(AskOrchestrator.prototype, "answer").mockImplementation(
      async (_run, _history, _hooks, signal) => {
        started();
        return new Promise<AskAnswer>((resolve, reject) => {
          release = () => resolve(answer);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );
    return { started, release: () => release() };
  }

  it("finishes the running answer inside the drain window, claims nothing more, then closes the pool and exits 0", async () => {
    const events: string[] = [];
    record(events);
    const waiting = pendingAnswer();
    // A request in flight holds the close before its onClose hooks, as a
    // slow log read does: claims must stop before it ends, not after.
    let finishRequest!: () => void;
    const app = await boot(events, (route) =>
      route.get("/slow", async () => {
        await new Promise<void>((resolve) => {
          finishRequest = resolve;
        });
        events.push("request-done");
        return {};
      }),
    );
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const request = fetch(`http://127.0.0.1:${port}/slow`);
    await vi.waitFor(() => expect(finishRequest).toBeTypeOf("function"));
    const running = await submit(0);
    await vi.waitFor(() => expect(waiting.started).toHaveBeenCalled(), { timeout: 3_000 });

    const { exit, first } = exits();
    const shutdown = createShutdown({
      timeoutMs: SHUTDOWN_CLOSE_RESERVE_MS + 8_000,
      exit: (code) => {
        events.push(`exit:${code}`);
        exit(code);
      },
      log: () => undefined,
    });
    shutdown.attach(app);
    const signalled = Date.now();
    shutdown.signal("SIGTERM");
    // Another person's question arrives while the api drains: it is left
    // queued for a replica that is serving, past more than one worker poll.
    const queued = await submit(1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await row(queued.id)).status).toBe("queued");
    expect((await row(running.id)).status).toBe("running");
    finishRequest();
    expect((await request).status).toBe(200);
    // The close has reached the runtime's onClose; the answer still runs.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await row(running.id)).status).toBe("running");
    expect(events).not.toContain("pool-closed");
    waiting.release();

    expect(await first).toBe(0);
    // Done when its work is, not when the 8 s drain window runs out.
    expect(Date.now() - signalled).toBeLessThan(6_000);
    expect((await row(running.id)).status).toBe("succeeded");
    expect((await row(queued.id)).status).toBe("queued");
    expect(events).toEqual([
      "claim",
      "stopping",
      "request-done",
      "run-succeeded",
      "pool-closed",
      "exit:0",
    ]);
  });

  it("a claim in flight when the replica stops claiming is its last", async () => {
    await submit(0);
    await submit(1);
    let claiming = true;
    const claim = store.claim.bind(store);
    const claims = vi.spyOn(store, "claim").mockImplementation(async (...args) => {
      const run = await claim(...args);
      claiming = false;
      return run;
    });
    pendingAnswer();
    const worker = new AskWorker(
      store,
      { ...readAskSettings(), workerConcurrency: 2 },
      {
        hooks: () => ({
          checkActive: async () => undefined,
          beforeModelStep: async () => crypto.randomUUID(),
          modelDispatched: async () => undefined,
          recordUsage: async () => undefined,
          recordTool: async () => undefined,
        }),
        afterTerminal: async () => undefined,
        canClaim: () => claiming,
      },
    );
    await worker.tick();
    await worker.stop();
    expect(claims).toHaveBeenCalledTimes(1);
  });

  it("interrupts an answer still running when the drain window ends, ending its lease before the pool closes", async () => {
    const events: string[] = [];
    record(events);
    const waiting = pendingAnswer();
    const app = await boot(events);
    const running = await submit(0);
    await vi.waitFor(() => expect(waiting.started).toHaveBeenCalled(), { timeout: 3_000 });

    const { exit, first } = exits();
    const timeoutMs = SHUTDOWN_CLOSE_RESERVE_MS + 500;
    const shutdown = createShutdown({
      timeoutMs,
      exit: (code) => {
        events.push(`exit:${code}`);
        exit(code);
      },
      log: () => undefined,
    });
    shutdown.attach(app);
    const started = Date.now();
    shutdown.signal("SIGTERM");

    expect(await first).toBe(0);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(timeoutMs);
    const ended = await row(running.id);
    expect(ended.status).toBe("interrupted");
    expect(ended.leaseToken).toBeNull();
    expect(events).toEqual([
      "claim",
      "stopping",
      "run-failed:ASK_INTERRUPTED",
      "pool-closed",
      "exit:0",
    ]);
  });
});
