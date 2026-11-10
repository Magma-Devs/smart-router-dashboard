import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * The db plugin's connect loop, with the driver replaced: what it hands the
 * driver, and what it does with a pool whose attempt failed.
 *
 * `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_S` and `DB_TLS_SERVERNAME` are read in
 * `config.ts` and applied in `@sr/db`, and each side has its own tests; the
 * first case pins the line between them, so a pool opened without them fails
 * here rather than on a fleet instance's connection budget.
 *
 * An attempt can fail after it connected (a migration that lost a race, a
 * statement the role may not run). The loop retries every 2 s at first, and a
 * pool left open keeps its connection for the idle timeout, so the retries of
 * one backend that cannot migrate fill the role's connection limit — the one
 * the deployment's serving backends share. These pin that a failed attempt's
 * pool is closed before the next attempt opens one.
 */
const driver = vi.hoisted(() => ({
  pools: [] as Array<{ end: ReturnType<typeof vi.fn>; db: { attempt: number } }>,
  opened: [] as unknown[][],
  migrate: vi.fn(),
  endFails: false,
}));

vi.mock("@sr/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sr/db")>();
  return {
    ...actual,
    createDb: vi.fn((...args: unknown[]) => {
      driver.opened.push(args);
      const end = vi.fn(async () => {
        if (driver.endFails) throw new Error("the socket is already gone");
      });
      const pool = { end, db: { attempt: driver.pools.length + 1 } };
      driver.pools.push(pool);
      return { db: pool.db, sql: { end } };
    }),
    migrate: (...args: unknown[]) => driver.migrate(...args),
  };
});

const { dbPlugin } = await import("../plugins/db.js");

const URL = "postgres://sr:x@192.0.2.1:5432/na";
const KNOBS = ["DATABASE_URL", "DB_POOL_MAX", "DB_IDLE_TIMEOUT_S", "DB_TLS_SERVERNAME"] as const;

let app: FastifyInstance | null = null;
const saved: Partial<Record<(typeof KNOBS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const name of KNOBS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.DATABASE_URL = URL;
  driver.pools.length = 0;
  driver.opened.length = 0;
  driver.migrate.mockReset();
  driver.endFails = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = null;
  for (const name of KNOBS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function register(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(dbPlugin);
  await instance.ready();
  return instance;
}

describe("the db plugin's connect loop", () => {
  it("opens the pool with the size, idle timeout and TLS server name from the environment", async () => {
    process.env.DB_POOL_MAX = "5";
    process.env.DB_IDLE_TIMEOUT_S = "0";
    process.env.DB_TLS_SERVERNAME = "fleet-prod.abc123.us-east-1.rds.amazonaws.com";
    driver.migrate.mockResolvedValue(undefined);
    app = await register();
    await app.dbReady;
    expect(driver.opened).toEqual([
      [URL, { max: 5, idleTimeout: 0, tlsServername: "fleet-prod.abc123.us-east-1.rds.amazonaws.com" }],
    ]);
  });

  it("opens the pool at the defaults when none of them is set", async () => {
    driver.migrate.mockResolvedValue(undefined);
    app = await register();
    await app.dbReady;
    expect(driver.opened).toEqual([[URL, { max: 20, idleTimeout: 30 }]]);
  });

  it("refuses to register on a malformed pool size, naming the variable", async () => {
    process.env.DB_POOL_MAX = "many";
    await expect(register()).rejects.toThrow(/DB_POOL_MAX/);
    expect(driver.opened).toHaveLength(0);
  });

  it("closes the pool of an attempt that failed before it opens the next", async () => {
    driver.migrate
      .mockRejectedValueOnce(new Error("permission denied for database"))
      .mockRejectedValueOnce(new Error("relation already exists"))
      .mockResolvedValue(undefined);
    app = await register();

    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pools).toHaveLength(1);
    expect(driver.pools[0]!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(app.db).toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(driver.pools).toHaveLength(2);
    expect(driver.pools[1]!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });

    await vi.advanceTimersByTimeAsync(2_000);
    await app.dbReady;
    expect(driver.pools).toHaveLength(3);
    expect(app.db).toBe(driver.pools[2]!.db);
    // The pool that connected stays open until the app closes.
    expect(driver.pools[2]!.end).not.toHaveBeenCalled();
    expect(driver.pools[0]!.end).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    await app.close();
    app = null;
    expect(driver.pools[2]!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
  });

  it("keeps retrying when closing the failed pool fails too", async () => {
    driver.endFails = true;
    driver.migrate.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValue(undefined);
    app = await register();

    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pools[0]!.end).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await app.dbReady;
    expect(app.db).toBe(driver.pools[1]!.db);
    driver.endFails = false;
  });
});
