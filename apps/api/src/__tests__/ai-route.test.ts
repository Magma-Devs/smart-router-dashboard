/**
 * `GET /api/ai/health` (MAG-3702).
 *
 * The route is free — it makes no model call — so these assert the one thing
 * that matters: it reports the RIGHT reason for being unavailable, and it
 * never leaks the credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

const KEY = "test-bearer-token";

describe("GET /api/ai/health", () => {
  let app: FastifyInstance;
  const saved = { auth: process.env.AUTH_MODE, key: process.env.AWS_BEARER_TOKEN_BEDROCK };

  beforeEach(() => {
    // The route makes no outbound call, but buildApp's readiness path might.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }), { status: 200 }));
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllGlobals();
    process.env.AUTH_MODE = saved.auth;
    if (saved.key === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = saved.key;
  });

  // The `auth_required` branch is covered in bedrock.test.ts rather than here:
  // AUTH_MODE=enabled makes buildApp() demand a DATABASE_URL, so exercising it
  // through the whole app would mean standing up Postgres to test a pure check.
  it("says not_configured when no key is set — the key check runs first", async () => {
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/ai/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: "not_configured", provider: "bedrock" });
  });

  it("reports which model and region it would use", async () => {
    app = await buildApp();
    const body = res_json(await app.inject({ method: "GET", url: "/api/ai/health" }));
    expect(body.model).toBeTruthy();
    expect(body.region).toBeTruthy();
  });

  it("never returns the credential", async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = KEY;
    app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/ai/health" });
    expect(res.body).not.toContain(KEY);
  });
});

function res_json(res: { json(): unknown }): Record<string, unknown> {
  return res.json() as Record<string, unknown>;
}
