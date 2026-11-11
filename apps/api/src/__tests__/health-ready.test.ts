import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, type TestDb } from "@sr/db/testing";
import type { Database } from "@sr/db";
import { buildApp } from "../app.js";
import { DB_READY_TIMEOUT_MS, setDbReadyTimeoutForTests } from "../routes/health.js";

/**
 * `GET /health/ready`, with and without a database behind the api.
 *
 * The gate fails closed while the database is unreachable, so a backend that
 * cannot reach it serves nobody — and until this probe looked at the database
 * it was Ready anyway. These pin that it is not: each way the database can be
 * missing reads as 503 with a reason, Prometheus alone still decides with auth
 * off, and Prometheus failing is still a 503 with the database fine.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
/** Any 32 bytes — the api needs one to boot with AUTH_MODE=enabled; no code is verified here. */
const TOTP_KEY = "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=";
const INTERNAL = "internal-secret-for-tests";
// Unroutable per RFC 5737 — the lazy connect loop never succeeds, which is one
// of the states under test; the tests that want a database swap in pglite.
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";

let app: FastifyInstance | null = null;
let t: TestDb;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A store that answers every instant query — enough for `vector(1)`. */
function prometheusAnswering(ok: boolean): void {
  vi.stubGlobal("fetch", async () =>
    ok
      ? new Response(
          JSON.stringify({
            status: "success",
            data: { resultType: "vector", result: [{ metric: {}, value: [1, "1"] }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : new Response("store is away", { status: 503 }),
  );
}

async function buildEnabledApp(): Promise<FastifyInstance> {
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    TOTP_ENCRYPTION_KEY: TOTP_KEY,
    INTERNAL_AUTH_SECRET: INTERNAL,
    DATABASE_URL: DEAD_DB,
  });
  return buildApp();
}

beforeEach(async () => {
  prometheusAnswering(true);
  t = await createTestDb();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await t.close();
  setDbReadyTimeoutForTests(DB_READY_TIMEOUT_MS);
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ready = () => app!.inject({ method: "GET", url: "/health/ready" });

describe("GET /health/ready", () => {
  it("with auth off, reports Prometheus and says nothing about a database", async () => {
    setEnv({ AUTH_MODE: "disabled" });
    app = await buildApp();
    const res = await ready();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", components: { prometheus: "ok" } });
  });

  it("with auth on and the database answering, is ready", async () => {
    app = await buildEnabledApp();
    app.db = t.db;
    const res = await ready();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ready",
      components: { prometheus: "ok", database: "ok" },
    });
  });

  it("is not ready while the database has not connected", async () => {
    app = await buildEnabledApp();
    const res = await ready();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "not_ready",
      components: { prometheus: "ok", database: "not_connected" },
    });
  });

  it("is not ready when the database refuses the query", async () => {
    app = await buildEnabledApp();
    app.db = {
      execute: async () => {
        throw new Error("terminating connection due to administrator command");
      },
    } as unknown as Database;
    const res = await ready();
    expect(res.statusCode).toBe(503);
    expect(res.json().components).toEqual({ prometheus: "ok", database: "query_failed" });
  });

  it("is not ready when the database does not answer in time", async () => {
    setDbReadyTimeoutForTests(50);
    app = await buildEnabledApp();
    app.db = { execute: () => new Promise(() => undefined) } as unknown as Database;
    const res = await ready();
    expect(res.statusCode).toBe(503);
    expect(res.json().components).toEqual({ prometheus: "ok", database: "timeout" });
  });

  it("is not ready when Prometheus is away, with the database fine", async () => {
    prometheusAnswering(false);
    app = await buildEnabledApp();
    app.db = t.db;
    const res = await ready();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "not_ready",
      components: { prometheus: "ping_failed", database: "ok" },
    });
  });

  it("stays public under the auth gate", async () => {
    app = await buildEnabledApp();
    app.db = t.db;
    const res = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { authorization: "Bearer not-a-token" },
    });
    expect(res.statusCode).toBe(200);
  });
});
