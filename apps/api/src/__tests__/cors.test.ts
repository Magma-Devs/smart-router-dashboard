import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

/**
 * The browser calls the api from the web's origin, so every method the web
 * sends has to survive the preflight. A method the answer leaves out is refused
 * by the browser before the api sees the request — which no `inject()` test of
 * the route itself can notice.
 */

let app: FastifyInstance | null = null;

beforeEach(async () => {
  app = await buildApp();
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("CORS preflight", () => {
  it.each(["GET", "POST", "PATCH", "DELETE"])("lets a cross-origin %s through", async (method) => {
    const res = await app!.inject({
      method: "OPTIONS",
      url: "/api/account/sessions",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": method,
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers["access-control-allow-methods"]).split(/,\s*/)).toContain(method);
  });
});
