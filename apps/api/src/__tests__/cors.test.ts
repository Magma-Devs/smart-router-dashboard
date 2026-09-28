import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

/**
 * CORS preflight — the browser-only failure mode.
 *
 * A method missing from `access-control-allow-methods` fails **in the browser
 * and nowhere else**: the request never reaches Fastify, so there is no route
 * handler, no log line and no status code, and the user sees a bare
 * `TypeError: Failed to fetch`. Neither curl nor `app.inject()` is subject to
 * CORS, so nothing about a route's own tests can notice.
 *
 * What makes this testable at all is that @fastify/cors answers the preflight
 * itself, inside Fastify, before routing — so `inject()` an OPTIONS with the
 * two request headers a browser sends and the answer is the real one.
 *
 * It shipped wrong once. `@fastify/cors` defaults `methods` to `GET,HEAD,POST`,
 * and the registration didn't override it, which silently broke every mutation
 * the account and team screens make.
 */

const ORIGIN = "http://localhost:3000";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function preflight(path: string, method: string) {
  app ??= await buildApp();
  return app.inject({
    method: "OPTIONS",
    url: path,
    headers: {
      origin: ORIGIN,
      "access-control-request-method": method,
      "access-control-request-headers": "authorization",
    },
  });
}

describe("CORS preflight", () => {
  /** Every route a browser reaches with something other than GET/POST. If one
   *  is added, add it here — this list is the reason the header is explicit. */
  const MUTATIONS: Array<[string, string]> = [
    ["DELETE", "/api/account/sessions/0f9b6d1e-0000-4000-8000-000000000000"],
    ["DELETE", "/api/account/sessions"],
    ["DELETE", "/api/team/invites/0f9b6d1e-0000-4000-8000-000000000000"],
    ["DELETE", "/api/team/members/0f9b6d1e-0000-4000-8000-000000000000"],
    ["PATCH", "/api/team/members/0f9b6d1e-0000-4000-8000-000000000000"],
  ];

  it.each(MUTATIONS)("allows %s %s", async (method, path) => {
    const res = await preflight(path, method);

    expect(res.statusCode).toBe(204);
    const allowed = String(res.headers["access-control-allow-methods"] ?? "")
      .split(",")
      .map((m) => m.trim().toUpperCase());
    expect(allowed).toContain(method);
  });

  it("still allows the reads", async () => {
    const res = await preflight("/api/metrics/overview", "GET");
    const allowed = String(res.headers["access-control-allow-methods"] ?? "");
    expect(allowed).toContain("GET");
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  it("lets the Authorization header through — without it every /api/* call is anonymous", async () => {
    const res = await preflight("/api/account/sessions", "DELETE");
    expect(String(res.headers["access-control-allow-headers"] ?? "").toLowerCase()).toContain(
      "authorization",
    );
  });
});
