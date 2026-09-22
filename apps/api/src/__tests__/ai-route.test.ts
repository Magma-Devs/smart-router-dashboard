/**
 * `GET /api/ai/health` (MAG-3702).
 *
 * The route is free — it makes no model call — so these assert the one thing
 * that matters: it reports the RIGHT reason for being unavailable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

// There is no credential to test with: the SDK signs with SigV4 from the
// ambient identity, so the route has nothing secret to leak in the first place.

describe("GET /api/ai/health", () => {
  let app: FastifyInstance;
  const saved = { auth: process.env.AUTH_MODE, enabled: process.env.BEDROCK_ENABLED };

  beforeEach(() => {
    // The route makes no outbound call, but buildApp's readiness path might.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }), { status: 200 }));
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllGlobals();
    process.env.AUTH_MODE = saved.auth;
    if (saved.enabled === undefined) delete process.env.BEDROCK_ENABLED;
    else process.env.BEDROCK_ENABLED = saved.enabled;
  });

  // The `auth_required` and `no_credentials` branches are covered in
  // bedrock.test.ts rather than here: AUTH_MODE=enabled makes buildApp()
  // demand a DATABASE_URL, so reaching them through the whole app would mean
  // standing up Postgres to test a pure check.
  it("says disabled when BEDROCK_ENABLED is unset — the cheap check runs first", async () => {
    delete process.env.BEDROCK_ENABLED;
    app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/ai/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: "disabled", provider: "bedrock" });
  });

  it("names SigV4, so nobody goes looking for an api key to configure", async () => {
    app = await buildApp();
    expect(res_json(await app.inject({ method: "GET", url: "/api/ai/health" })).auth).toBe("sigv4");
  });

  it("reports which model and region it would use", async () => {
    app = await buildApp();
    const body = res_json(await app.inject({ method: "GET", url: "/api/ai/health" }));
    expect(body.model).toBeTruthy();
    expect(body.region).toBeTruthy();
  });

  it("carries no credential material of any kind in the body", async () => {
    app = await buildApp();
    const body = (await app.inject({ method: "GET", url: "/api/ai/health" })).body;
    // SigV4 signs per-request inside the SDK; nothing credential-shaped should
    // ever reach a response, and these are the shapes that would.
    expect(body).not.toMatch(/AKIA|ASIA|aws_secret|sessionToken|Bearer /i);
  });
});

function res_json(res: { json(): unknown }): Record<string, unknown> {
  return res.json() as Record<string, unknown>;
}
