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
 *
 * With `DATABASE_RUNTIME_URL` an attempt opens two: the owner's single
 * connection, which migrates and grants and is closed once the boot is done,
 * and the runtime role's pool, which serves. The grant pass itself runs
 * against a real database in `@sr/db`'s `runtime-role.test.ts`.
 */
const driver = vi.hoisted(() => ({
  pools: [] as Array<{ end: ReturnType<typeof vi.fn>; db: { attempt: number } }>,
  opened: [] as unknown[][],
  migrate: vi.fn(),
  currentRole: vi.fn(),
  grant: vi.fn(),
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
    currentRole: (...args: unknown[]) => driver.currentRole(...args),
    grantRuntimeRole: (...args: unknown[]) => driver.grant(...args),
  };
});

const { dbPlugin, dbFailureReason } = await import("../plugins/db.js");
const { RuntimeRoleError } = await import("@sr/db");

const URL = "postgres://sr:x@192.0.2.1:5432/na";
const RUNTIME_URL = "postgres://sr_app:y@192.0.2.1:5432/na";
const KNOBS = [
  "DATABASE_URL",
  "DATABASE_RUNTIME_URL",
  "DB_POOL_MAX",
  "DB_IDLE_TIMEOUT_S",
  "DB_TLS_SERVERNAME",
] as const;

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
  driver.currentRole.mockReset();
  driver.grant.mockReset();
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

/** What the ORM throws: its own message, the driver's error on `cause`. */
function failedQuery(cause: Error & { code?: string }): Error {
  return new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"\nparams: ', { cause });
}

const logged: Array<Record<string, unknown>> = [];

async function register(): Promise<FastifyInstance> {
  logged.length = 0;
  const instance = Fastify({
    logger: {
      level: "warn",
      stream: { write: (line: string) => void logged.push(JSON.parse(line) as Record<string, unknown>) },
    },
  });
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

  it("logs why an attempt failed, not only the query that did", async () => {
    driver.migrate
      .mockRejectedValueOnce(
        failedQuery(Object.assign(new Error('password authentication failed for user "acme"'), { code: "28P01" })),
      )
      .mockResolvedValue(undefined);
    app = await register();
    await vi.advanceTimersByTimeAsync(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      msg: "database not ready, retrying",
      attempt: 1,
      reason: '28P01: password authentication failed for user "acme"',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await app.dbReady;
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

describe("the db plugin's connect loop with a runtime role", () => {
  const REPORT = { role: "sr_app", owner: "sr", tables: ["users", "sessions"], appendOnly: ["audit_events"] };

  it("migrates as DATABASE_URL over one connection, grants, closes it, and serves as the runtime role", async () => {
    process.env.DATABASE_RUNTIME_URL = RUNTIME_URL;
    process.env.DB_POOL_MAX = "5";
    process.env.DB_TLS_SERVERNAME = "fleet-prod.abc123.us-east-1.rds.amazonaws.com";
    const order: string[] = [];
    driver.migrate.mockImplementation(async () => void order.push("migrate"));
    driver.currentRole.mockImplementation(async () => {
      order.push("currentRole");
      return "sr_app";
    });
    driver.grant.mockImplementation(async () => {
      order.push("grant");
      return REPORT;
    });
    app = await register();
    await app.dbReady;

    const tls = { tlsServername: "fleet-prod.abc123.us-east-1.rds.amazonaws.com" };
    expect(driver.opened).toEqual([
      [URL, { max: 1, idleTimeout: 30, ...tls }],
      [RUNTIME_URL, { max: 5, idleTimeout: 30, ...tls }],
    ]);
    const [owner, runtime] = driver.pools;
    expect(order).toEqual(["migrate", "currentRole", "grant"]);
    expect(driver.migrate).toHaveBeenCalledExactlyOnceWith(owner!.db);
    expect(driver.currentRole).toHaveBeenCalledExactlyOnceWith(runtime!.db);
    expect(driver.grant).toHaveBeenCalledExactlyOnceWith(owner!.db, "sr_app");
    // The owner's connection is gone once the boot is done; requests go to the runtime pool.
    expect(owner!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
    expect(app.db).toBe(runtime!.db);
    expect(runtime!.end).not.toHaveBeenCalled();
  });

  it("treats a blank DATABASE_RUNTIME_URL as unset: one role, as before", async () => {
    process.env.DATABASE_RUNTIME_URL = " ";
    driver.migrate.mockResolvedValue(undefined);
    app = await register();
    await app.dbReady;
    expect(driver.opened).toEqual([[URL, { max: 20, idleTimeout: 30 }]]);
    expect(driver.grant).not.toHaveBeenCalled();
    expect(app.db).toBe(driver.pools[0]!.db);
  });

  it("does not serve with a runtime role that could alter the log: both pools closed, an error logged, retried", async () => {
    process.env.DATABASE_RUNTIME_URL = RUNTIME_URL;
    driver.migrate.mockResolvedValue(undefined);
    driver.currentRole.mockResolvedValue("sr_app");
    driver.grant
      .mockRejectedValueOnce(new RuntimeRoleError("sr_app", ["it can use DELETE on audit_events"]))
      .mockResolvedValue(REPORT);
    app = await register();

    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pools).toHaveLength(2);
    expect(driver.pools[0]!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(driver.pools[1]!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(app.db).toBeNull();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 50, attempt: 1, runtimeRole: "sr_app" });
    expect(String(logged[0]!.err)).toMatch(/it can use DELETE on audit_events/);

    // Fixed out of band (the role re-provisioned): the next attempt serves.
    await vi.advanceTimersByTimeAsync(2_000);
    await app.dbReady;
    expect(driver.pools).toHaveLength(4);
    expect(app.db).toBe(driver.pools[3]!.db);
  });

  it("closes the owner's pool when the runtime credential is refused", async () => {
    process.env.DATABASE_RUNTIME_URL = RUNTIME_URL;
    driver.migrate.mockResolvedValue(undefined);
    driver.currentRole
      .mockRejectedValueOnce(
        failedQuery(Object.assign(new Error('password authentication failed for user "sr_app"'), { code: "28P01" })),
      )
      .mockResolvedValue("sr_app");
    driver.grant.mockResolvedValue(REPORT);
    app = await register();

    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pools[0]!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(driver.pools[1]!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(driver.grant).not.toHaveBeenCalled();
    expect(logged[0]).toMatchObject({
      msg: "database not ready, retrying",
      reason: '28P01: password authentication failed for user "sr_app"',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await app.dbReady;
  });
});

describe("dbFailureReason", () => {
  it("names the driver's code and message behind the ORM's wrapper", () => {
    expect(
      dbFailureReason(
        failedQuery(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })),
      ),
    ).toBe("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:5432");
    expect(dbFailureReason(failedQuery(new Error("socket hang up")))).toBe("socket hang up");
  });

  it("says nothing for an error with no cause", () => {
    expect(dbFailureReason(new Error("boom"))).toBeUndefined();
    expect(dbFailureReason("boom")).toBeUndefined();
    expect(dbFailureReason(null)).toBeUndefined();
  });
});
