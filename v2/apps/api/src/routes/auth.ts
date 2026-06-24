import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { sendApiError } from "../plugins/error-handler.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

interface LoginBody {
  username?: string;
  password?: string;
}

/** Minimal session-less basic-auth login, ported from the Python backend. */
export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", {
    schema: {
      tags: ["Auth"],
      summary: "Basic-auth sign-in",
      body: {
        type: "object" as const,
        required: ["username", "password"],
        properties: { username: { type: "string" as const }, password: { type: "string" as const } },
      },
    },
  }, async (request, reply) => {
    const { username, password } = (request.body ?? {}) as LoginBody;
    if (
      !username ||
      !password ||
      !safeEqual(username, config.auth.username) ||
      !safeEqual(password, config.auth.password)
    ) {
      sendApiError(reply, 401, "Invalid credentials");
      return reply;
    }
    // Echo back the basic token the browser should send on subsequent calls.
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    return { user: { username }, token };
  });

  app.get("/api/auth/status", { schema: { tags: ["Auth"], summary: "Whether the auth gate is enabled" } }, async () => ({
    authEnabled: config.auth.enabled,
  }));
}
