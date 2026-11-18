import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { askBudgetMonths, askMaintenance, askModelSteps, users } from "@sr/db";
import { SignJWT } from "jose";
import { authPlugin, SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";
import { installAskRuntime } from "../services/ask/runtime.js";
import { AskOrchestrator } from "../services/ask/orchestrator.js";
import { BedrockAdapter } from "../services/ask/bedrock.js";
import { AskWorker } from "../services/ask/worker.js";
import { McpAdapter } from "../services/ask/mcp.js";
import { askRoutes } from "../routes/ask.js";

const secret = "runtime-ask-secret-with-at-least-32-characters";
let app: FastifyInstance;
let t: TestDb;
let token: string;
beforeEach(async () => {
  for (const [key, value] of Object.entries({
    AUTH_MODE: "enabled",
    AUTH_SECRET: secret,
    INTERNAL_AUTH_SECRET: secret,
    TOTP_ENCRYPTION_KEY: "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=",
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
  const [user] = await t.db
    .insert(users)
    .values({ email: "runtime@example.test", ...enrolledTwoFactor() })
    .returning();
  const session = await createSession(t.db, {
    userId: user!.id,
    authMethod: "password",
    client: { ip: "127.0.0.1", userAgent: "Runtime fixture" },
  });
  token = await new SignJWT({
    sub: user!.id,
    sid: session.id,
    role: "read_only",
    email: user!.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
});
afterEach(async () => {
  await app?.close();
  await t.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const request = (url: string, payload?: unknown) =>
  app.inject({
    url: `/api/ask${url}`,
    method: payload === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
async function boot() {
  app = Fastify();
  app.decorate("db", t.db);
  app.decorate("dbReady", Promise.resolve());
  await app.register(authPlugin);
  const runtime = installAskRuntime(app);
  await app.register(askRoutes, runtime);
  await app.ready();
  return runtime;
}
describe("API runtime accounting/worker wiring", () => {
  it("persists a clock reply through HTTP and the real worker with zero external work or spend", async () => {
    const count = vi.spyOn(BedrockAdapter.prototype, "countTokens");
    const connect = vi.spyOn(McpAdapter.prototype, "withConnection");
    const runtime = await boot();
    await vi.waitFor(() => expect(runtime.ready()).toBe(true));
    const chatResponse = await request("/chats", {});
    expect(chatResponse.statusCode).toBe(200);
    const chat = chatResponse.json() as { id: string };
    const started = Date.now();
    const submission = await request(`/chats/${chat.id}/runs`, {
      idempotencyKey: crypto.randomUUID(),
      question: "what is the date today?",
    });
    expect(submission.statusCode).toBe(200);
    const run = submission.json() as { id: string };
    await vi.waitFor(
      async () => expect((await request(`/runs/${run.id}`)).json().status).toBe("succeeded"),
      { timeout: 3000 },
    );
    const detail = (await request(`/chats/${chat.id}`)).json();
    expect(detail.messages).toHaveLength(2);
    const answer = detail.messages[1].answer;
    expect(answer.summary).toContain("UTC");
    expect(Date.parse(answer.answeredAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(answer.answeredAt)).toBeLessThanOrEqual(Date.now());
    expect(answer.evidence).toEqual([]);
    expect(count).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(await t.db.select().from(askModelSteps)).toEqual([]);
    expect(await t.db.select().from(askBudgetMonths)).toEqual([
      expect.objectContaining({ spentMicroUsd: 0n, reservedMicroUsd: 0n }),
    ]);
    expect((await app.inject({ url: `/api/ask/chats/${chat.id}` })).statusCode).toBe(401);
    vi.stubEnv("ASK_DATA_ENABLED", "false");
    expect(
      (
        await request(`/chats/${chat.id}/runs`, {
          idempotencyKey: crypto.randomUUID(),
          question: "What time is it?",
        })
      ).statusCode,
    ).toBe(404);
  });
  it("connects HTTP admission, free count, durable dispatch/usage, answer persistence and maintenance", async () => {
    vi.spyOn(BedrockAdapter.prototype, "countTokens").mockResolvedValue(100);
    vi.spyOn(AskOrchestrator.prototype, "answer").mockImplementation(
      async (_run, _history, hooks) => {
        await hooks.checkActive();
        const id = await hooks.beforeModelStep({
          input: {
            system: "Fixture",
            messages: [{ role: "user", content: [{ text: "Synthetic prompt" }] }],
          },
          inputBytes: 100,
          outputTokens: 2048,
        });
        await hooks.modelDispatched(id);
        await hooks.recordUsage(
          id,
          { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          { requestId: "runtime-receipt", providerStatus: 200 },
        );
        return {
          contractVersion: 1,
          summary: "Synthetic result",
          sections: [{ title: "Fixture", body: "No live data." }],
          answeredAt: new Date().toISOString(),
          evidence: [],
        };
      },
    );
    const runtime = await boot();
    await vi.waitFor(() => expect(runtime.ready()).toBe(true));
    expect((await request("/capabilities")).json().acceptingQuestions).toBe(true);
    const chat = (await request("/chats", {})).json() as { id: string };
    const run = (
      await request(`/chats/${chat.id}/runs`, {
        idempotencyKey: crypto.randomUUID(),
        question: "Synthetic question",
      })
    ).json() as { id: string };
    await vi.waitFor(
      async () => expect((await request(`/runs/${run.id}`)).json().status).toBe("succeeded"),
      { timeout: 3000 },
    );
    expect((await request(`/chats/${chat.id}`)).json().messages).toHaveLength(2);
    expect((await t.db.select().from(askModelSteps))[0]).toMatchObject({
      state: "settled",
      chargedMicroUsd: 20n,
      providerRequestId: "runtime-receipt",
    });
    await vi.waitFor(async () =>
      expect((await t.db.select().from(askMaintenance))[0]?.lastSuccessAt).toBeInstanceOf(Date),
    );
    vi.stubEnv("ASK_DATA_ENABLED", "false");
    expect(runtime.ready()).toBe(false);
    expect((await request("/capabilities")).statusCode).toBe(404);
  });
  it("keeps paid admission unavailable without verified pricing while retention still runs", async () => {
    vi.stubEnv("ASK_DATA_PRICING_JSON", "");
    const start = vi.spyOn(AskWorker.prototype, "start");
    const runtime = await boot();
    expect(runtime.ready()).toBe(false);
    expect((await request("/capabilities")).json().acceptingQuestions).toBe(false);
    const chat = (await request("/chats", {})).json() as { id: string };
    expect(
      (
        await request(`/chats/${chat.id}/runs`, {
          idempotencyKey: crypto.randomUUID(),
          question: "No pricing",
        })
      ).statusCode,
    ).toBe(503);
    expect(start).not.toHaveBeenCalled();
    await vi.waitFor(async () =>
      expect((await t.db.select().from(askMaintenance))[0]?.lastSuccessAt).toBeInstanceOf(Date),
    );
  });
  it("closes without waiting for an unavailable database and cannot start late", async () => {
    let resolve!: () => void;
    const ready = new Promise<void>((done) => {
      resolve = done;
    });
    app = Fastify();
    app.decorate("db", t.db);
    app.decorate("dbReady", ready);
    const start = vi.spyOn(AskWorker.prototype, "start");
    const runtime = installAskRuntime(app);
    await app.ready();
    await app.close();
    resolve();
    await ready;
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(runtime.ready()).toBe(false);
  });
});
