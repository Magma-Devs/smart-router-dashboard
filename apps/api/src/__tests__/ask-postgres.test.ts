import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { eq, sql } from "drizzle-orm";
import {
  askBudgetMonths,
  askModelSteps,
  askChats,
  askMessages,
  askRuns,
  askToolEvents,
  createDb,
  migrate,
  users,
  type DbHandle,
} from "@sr/db";
import { enrolledTwoFactor } from "@sr/db/testing";
import { readAskSettings } from "../config.js";
import { authPlugin, SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { askRoutes } from "../routes/ask.js";
import { createSession, revokeSession } from "../services/sessions.js";
import { AskStore, type AskAdmission } from "../services/ask/store.js";
import { BedrockAdapter } from "../services/ask/bedrock.js";
import { AskBudget } from "../services/ask/budget.js";
import { AskRetention } from "../services/ask/retention.js";
import { AskFailure } from "../services/ask/errors.js";
import { prefetchRead } from "../services/ask/prefetch.js";
import type { AskChatDetail, AskChatPage, AskPreferences, AskRun } from "@sr/shared";

/** Deliberately opt-in and destructive only to a named test database. The CI
 * job supplies its own PostgreSQL. No default URL ever points at a real tenant. */
const databaseUrl = process.env.ASK_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const SECRET = "ask-real-http-postgres-session-secret";
const answer = {
  contractVersion: 1 as const,
  summary: "Fixture answer",
  sections: [{ title: "Fixture", body: "Test evidence only." }],
  answeredAt: "2026-11-16T10:00:00Z",
  evidence: [],
};
interface Actor {
  id: string;
  sessionId: string;
  headers: Record<string, string>;
}
interface Server {
  app: FastifyInstance;
  url: string;
}
// Tests assert the applicable response shape before reading its fields.
type TestBody = AskChatDetail &
  AskChatPage &
  AskPreferences &
  AskRun & { code?: string; run: AskRun | null; acceptingQuestions?: boolean; scopeId?: string };

suite("Ask HTTP backed by independent PostgreSQL connections", () => {
  const handles: DbHandle[] = [];
  const servers: Server[] = [];
  let a: Server;
  let replica: Server;
  let b: Server;
  let alice: Actor;
  let bob: Actor;
  let aStore: AskStore;
  let replicaStore: AskStore;
  let rejectAdmission = false;
  const admission: AskAdmission = async () => {
    if (rejectAdmission) throw new AskFailure("ASK_BUDGET_LIMIT", 429);
  };
  let modelSpy: ReturnType<typeof vi.spyOn>;

  async function actor(): Promise<Actor> {
    const [user] = await handles[0]!.db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}@example.test`,
        role: "read_only",
        ...enrolledTwoFactor(),
      })
      .returning();
    const session = await createSession(handles[0]!.db, {
      userId: user!.id,
      authMethod: "password",
      client: { ip: "127.0.0.1", userAgent: "Real HTTP PostgreSQL fixture" },
    });
    const token = await new SignJWT({
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
      .sign(new TextEncoder().encode(SECRET));
    return { id: user!.id, sessionId: session.id, headers: { authorization: `Bearer ${token}` } };
  }
  async function server(
    handle: DbHandle,
    customerId: string,
    admit?: AskAdmission,
  ): Promise<Server> {
    const settings = readAskSettings({
      AUTH_MODE: "enabled",
      DEPLOYMENT_MODE: "managed",
      ASK_DATA_ENABLED: "true",
      ASK_DATA_CUSTOMER_ID: customerId,
      ASK_DATA_MCP_TOKEN: "test-customer-token",
      AWS_BEARER_TOKEN_BEDROCK: "test-provider-token",
      ASK_DATA_BEDROCK_MODEL: "test-model",
    });
    const app = Fastify({ logger: false });
    app.decorate("db", handle.db);
    await app.register(authPlugin);
    await app.register(askRoutes, { settings, ...(admit ? { admit } : {}) });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const instance = { app, url };
    servers.push(instance);
    return instance;
  }
  async function request(
    target: Server,
    person: Actor,
    path: string,
    method = "GET",
    body?: unknown,
  ) {
    const response = await fetch(`${target.url}/api/ask${path}`, {
      method,
      headers: {
        ...person.headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as TestBody };
  }
  async function chat(target = a, person = alice): Promise<string> {
    const r = await request(target, person, "/chats", "POST", {});
    expect(r.status).toBe(200);
    return r.body.id as string;
  }
  const submit = (
    target: Server,
    person: Actor,
    chatId: string,
    key = crypto.randomUUID(),
    question = "What happened on ETH1?",
  ) => request(target, person, `/chats/${chatId}/runs`, "POST", { idempotencyKey: key, question });

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (
      !parsed.pathname.startsWith("/ask_test_") ||
      !["localhost", "127.0.0.1", "postgres"].includes(parsed.hostname)
    )
      throw new Error(
        "ASK_TEST_DATABASE_URL must use an isolated ask_test_* database on an approved local test host",
      );
    vi.stubEnv("AUTH_SECRET", SECRET);
    vi.stubEnv("INTERNAL_AUTH_SECRET", "ask-http-internal-test-secret");
    vi.stubEnv("TOTP_ENCRYPTION_KEY", "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=");
    for (let i = 0; i < 3; i++) handles.push(createDb(databaseUrl!));
    await migrate(handles[0]!.db);
    alice = await actor();
    bob = await actor();
    a = await server(handles[0]!, "customer-a", admission);
    replica = await server(handles[1]!, "customer-a", admission);
    b = await server(handles[2]!, "customer-b", admission);
    aStore = new AskStore(handles[0]!.db, "customer-a", 90);
    replicaStore = new AskStore(handles[1]!.db, "customer-a", 90);
    modelSpy = vi.spyOn(BedrockAdapter.prototype, "converse");
  });
  beforeEach(async () => {
    await handles[0]!.db.execute(
      sql`truncate ask_staff_access, ask_maintenance, ask_tool_events, ask_model_steps, ask_budget_months, ask_preferences, ask_messages, ask_runs, ask_chats restart identity cascade`,
    );
    rejectAdmission = false;
  });
  afterAll(async () => {
    expect(modelSpy).not.toHaveBeenCalled();
    await Promise.all(servers.map((s) => s.app.close()));
    await Promise.all(handles.map((h) => h.sql.end()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("redacts common credential formats before persistence and history reads", async () => {
    const id = await chat();
    const secrets = [
      "synthetic-basic-private",
      "synthetic-client-private",
      "synthetic-cookie-private",
      "synthetic-url-private",
    ];
    const question = [
      `Authorization: Basic ${secrets[0]}`,
      `client_secret="${secrets[1]}"`,
      `Cookie: session=${secrets[2]}; other=private-cookie`,
      `wss://fixture.test/${secrets[3]}?key=private-url`,
    ].join("\n");
    expect((await submit(a, alice, id, crypto.randomUUID(), question)).status).toBe(200);
    const rows = await handles[0]!.db.select().from(askRuns);
    const messages = await handles[0]!.db.select().from(askMessages);
    const detail = await request(a, alice, `/chats/${id}`);
    for (const secret of secrets) {
      expect(
        JSON.stringify([
          rows.map((row) => row.question),
          messages.map((row) => row.question),
          detail.body,
        ]),
      ).not.toContain(secret);
    }
    expect(rows[0]!.question).toContain("[redacted]");
  });

  it("enforces personal/customer ownership on read, search, submit, cancel and preferences", async () => {
    const id = await chat();
    const run = await submit(a, alice, id);
    expect(run.status).toBe(200);
    for (const [target, person] of [
      [a, bob],
      [b, alice],
    ] as const) {
      expect((await request(target, person, `/chats/${id}`)).status).toBe(404);
      expect((await request(target, person, `/runs/${run.body.id}`)).status).toBe(404);
      expect((await request(target, person, `/runs/${run.body.id}/cancel`, "POST")).status).toBe(
        404,
      );
      expect((await submit(target, person, id)).status).toBe(404);
      expect(
        (
          await request(target, person, "/preferences", "PATCH", {
            view: "full",
            chatId: id,
            returnTo: "/metrics",
          })
        ).status,
      ).toBe(404);
      expect((await request(target, person, "/chats?query=ETH1")).body.chats).toEqual([]);
    }
    expect((await request(replica, alice, `/chats/${id}`)).body.messages).toHaveLength(1);
  });

  it("admits one question per person across replicas while another person proceeds", async () => {
    const firstChat = await chat();
    const secondChat = await chat();
    const bobChat = await chat(a, bob);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        submit(i % 2 ? a : replica, alice, i % 2 ? firstChat : secondChat),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409 && r.body.code === "ASK_ACTIVE_RUN"),
    ).toHaveLength(11);
    expect((await submit(replica, bob, bobChat)).status).toBe(200);
    expect((await request(replica, alice, "/runs/active")).body.run!.id).toBe(
      results.find((r) => r.status === 200)!.body.id,
    );
  });

  it("reports a running answer's step and finished reads from any replica, this customer's only", async () => {
    const id = await chat();
    const run = await submit(a, alice, id);
    expect((await request(a, alice, "/runs/active")).body.run!.progress).toBeUndefined();
    expect((await aStore.claim(30_000))!.id).toBe(run.body.id);
    const started = await request(replica, alice, "/runs/active");
    expect(started.body.run!.progress).toEqual({ step: "starting", reads: [] });

    const month = "2026-11";
    for (const customerId of ["customer-a", "customer-b"])
      await handles[0]!.db
        .insert(askBudgetMonths)
        .values({ customerId, month, limitMicroUsd: 1_000_000n });
    const step = (customerId: string, state: "reserved" | "settled", at: string) => ({
      runId: run.body.id,
      customerId,
      month,
      feature: "ask" as const,
      state,
      inputTokenBound: 10,
      outputTokenBound: 10,
      reservedMicroUsd: 10n,
      chargedMicroUsd: state === "settled" ? 5n : null,
      pricing: {},
      createdAt: new Date(at),
      completedAt: state === "settled" ? new Date(at) : null,
    });
    await handles[0]!.db
      .insert(askModelSteps)
      .values(step("customer-a", "settled", "2026-11-22T20:00:00Z"));
    // Another customer's turn with the same run id must not move this run's step.
    await handles[0]!.db
      .insert(askModelSteps)
      .values(step("customer-b", "reserved", "2026-11-22T20:00:05Z"));
    expect((await request(replica, alice, "/runs/active")).body.run!.progress).toEqual({
      step: "working",
      reads: [],
    });

    await handles[0]!.db.insert(askToolEvents).values({
      runId: run.body.id,
      customerId: "customer-a",
      sourceId: "customer-a-metrics",
      operationId: "metrics.query",
      parameters: {
        query:
          'sum by (chain) (sum_over_time(smartrouter_final_failures:count1m{cluster="customer-a"}[24h]))',
      },
      evidence: {},
      ok: "success",
      latencyMs: 700,
      createdAt: new Date("2026-11-22T20:00:01Z"),
    });
    expect((await request(a, alice, "/runs/active")).body.run!.progress).toEqual({
      step: "reading",
      reads: [{ label: "Failure counts", ok: true }],
    });

    await handles[0]!.db
      .insert(askModelSteps)
      .values(step("customer-a", "reserved", "2026-11-22T20:00:02Z"));
    expect((await request(replica, alice, "/runs/active")).body.run!.progress).toEqual({
      step: "reviewing",
      reads: [{ label: "Failure counts", ok: true }],
    });
    // The person's chat view still lists the run without progress.
    expect((await request(a, alice, `/runs/${run.body.id}`)).body.progress).toBeUndefined();
    expect((await request(b, alice, "/runs/active")).body.run).toBeNull();
  });

  it("returns the same run/message on concurrent idempotent retry and rejects changed content", async () => {
    const id = await chat();
    const key = crypto.randomUUID();
    const results = await Promise.all([
      submit(a, alice, id, key),
      submit(replica, alice, id, key),
      submit(a, alice, id, key),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect((await request(a, alice, `/chats/${id}`)).body.messages).toHaveLength(1);
    expect((await submit(replica, alice, id, key, "Different question")).body.code).toBe(
      "ASK_CONFLICT",
    );
    expect(await handles[1]!.db.select().from(askRuns)).toHaveLength(1);
  });

  it("atomically rolls back admission failure without leaving a message or active lock", async () => {
    const id = await chat();
    const key = crypto.randomUUID();
    rejectAdmission = true;
    expect((await submit(a, alice, id, key)).body.code).toBe("ASK_BUDGET_LIMIT");
    expect((await request(a, alice, `/chats/${id}`)).body.messages).toEqual([]);
    expect((await request(a, alice, "/runs/active")).body.run).toBeNull();
    rejectAdmission = false;
    expect((await submit(replica, alice, id, key)).status).toBe(200);
  });

  it("cancels one queued run while the other customer's run stays open", async () => {
    const aChat = await chat();
    const bChat = await chat(b, alice);
    const aRun = await submit(a, alice, aChat);
    const bRun = await submit(b, alice, bChat);
    expect(
      (await request(replica, alice, `/runs/${aRun.body.id}/cancel`, "POST")).body.status,
    ).toBe("cancelled");
    expect((await request(a, alice, `/runs/${aRun.body.id}/cancel`, "POST")).body.status).toBe(
      "cancelled",
    );
    expect((await request(b, alice, `/runs/${bRun.body.id}`)).body.status).toBe("queued");
    expect((await submit(replica, alice, aChat)).status).toBe(200);
  });

  it("serves a running answer's draft from any replica, written only under its lease and cleared at the end", async () => {
    const id = await chat();
    const run = await submit(a, alice, id);
    const lease = (await aStore.claim(30_000))!;
    expect(await aStore.saveDraft(lease.id, lease.leaseToken!, "Two chains failed.")).toBe(true);
    expect((await request(replica, alice, "/runs/active")).body.run!.progress).toEqual({
      step: "starting",
      reads: [],
      draft: "Two chains failed.",
    });
    // Another customer's store and a stale lease token write nothing.
    expect(
      await new AskStore(handles[0]!.db, "customer-b", 90).saveDraft(
        lease.id,
        lease.leaseToken!,
        "other",
      ),
    ).toBe(false);
    expect(await aStore.saveDraft(lease.id, crypto.randomUUID(), "stale")).toBe(false);
    expect((await request(a, alice, "/runs/active")).body.run!.progress!.draft).toBe(
      "Two chains failed.",
    );
    // The person's own run and chat reads never carry it.
    expect(JSON.stringify((await request(a, alice, `/runs/${run.body.id}`)).body)).not.toContain(
      "Two chains",
    );
    expect(await aStore.succeed(lease.id, lease.leaseToken!, answer)).toBe(true);
    expect(await aStore.saveDraft(lease.id, lease.leaseToken!, "late")).toBe(false);
    const [row] = await handles[0]!.db
      .select({ draft: askRuns.draft })
      .from(askRuns)
      .where(eq(askRuns.id, lease.id));
    expect(row!.draft).toBeNull();
  });

  it("clears a failed run's draft", async () => {
    const id = await chat();
    await submit(a, alice, id);
    const lease = (await aStore.claim(30_000))!;
    expect(await aStore.saveDraft(lease.id, lease.leaseToken!, "Partial")).toBe(true);
    expect(await aStore.fail(lease.id, lease.leaseToken!, "ASK_INVALID_ANSWER")).toBe(true);
    const [row] = await handles[0]!.db
      .select({ draft: askRuns.draft })
      .from(askRuns)
      .where(eq(askRuns.id, lease.id));
    expect(row!.draft).toBeNull();
  });

  it("claims each queued run once with independent workers and fences late completion after cancellation", async () => {
    const id = await chat();
    const run = await submit(a, alice, id);
    const claims = await Promise.all([
      aStore.claim(10_000),
      replicaStore.claim(10_000),
      aStore.claim(10_000),
    ]);
    const claimed = claims.filter((r) => r !== null);
    expect(claimed).toHaveLength(1);
    const lease = claimed[0]!;
    expect(lease.attempts).toBe(1);
    expect((await request(replica, alice, `/runs/${run.body.id}/cancel`, "POST")).body.status).toBe(
      "cancelling",
    );
    expect(await aStore.succeed(lease.id, lease.leaseToken!, answer)).toBe(false);
    expect(await replicaStore.fail(lease.id, lease.leaseToken!, "ASK_CANCELLED")).toBe(true);
    const detail = await request(a, alice, `/chats/${id}`);
    expect(detail.body.messages).toHaveLength(1);
    expect((await request(a, alice, `/runs/${run.body.id}`)).body.status).toBe("cancelled");
  });

  it("recovers a crashed worker without replay, rejects its old lease, and admits a new question", async () => {
    const id = await chat();
    await submit(a, alice, id);
    const lease = (await aStore.claim(30))!;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await replicaStore.recover(120_000)).toBe(1);
    expect(await aStore.heartbeat(lease.id, lease.leaseToken!, 1000)).toBe(false);
    expect(await aStore.succeed(lease.id, lease.leaseToken!, answer)).toBe(false);
    expect((await request(replica, alice, `/runs/${lease.id}`)).body).toMatchObject({
      status: "interrupted",
      answer: null,
    });
    expect((await submit(replica, alice, id)).status).toBe(200);
  });

  it("publishes a validated answer once, with ordered messages and useful retained failure", async () => {
    const id = await chat();
    const first = await submit(a, alice, id);
    const lease = (await aStore.claim(10_000))!;
    expect(await replicaStore.succeed(lease.id, lease.leaseToken!, answer)).toBe(true);
    expect(await aStore.succeed(lease.id, lease.leaseToken!, answer)).toBe(false);
    const second = await submit(a, alice, id);
    const nextLease = (await replicaStore.claim(10_000))!;
    expect(await aStore.fail(nextLease.id, nextLease.leaseToken!, "ASK_MCP_UNAVAILABLE")).toBe(
      true,
    );
    expect((await request(a, alice, `/runs/${first.body.id}`)).body.answer!.summary).toBe(
      answer.summary,
    );
    expect((await request(a, alice, `/runs/${second.body.id}`)).body).toMatchObject({
      status: "failed",
      answer: null,
      error: { code: "ASK_MCP_UNAVAILABLE" },
    });
    expect(
      (await request(a, alice, `/chats/${id}`)).body.messages.map((m: { role: string }) => m.role),
    ).toEqual(["user", "assistant", "user"]);
  });

  it("names each source from its tool event's read and never stores a label in the answer", async () => {
    const id = await chat();
    const submitted = await submit(a, alice, id);
    const lease = (await aStore.claim(10_000))!;
    const item = {
      id: crypto.randomUUID(),
      sourceId: "acme-metrics",
      operationId: "metrics.query_range",
      observedAt: "2026-11-16T10:00:00Z",
      from: "2026-11-15T10:00:00Z",
      to: "2026-11-16T10:00:00Z",
      coverage: "complete" as const,
      truncated: false,
    };
    const parameters = prefetchRead(1_795_377_600).parameters;
    const label = "Request counts and failure counts and log line counts";
    await handles[0]!.db.insert(askToolEvents).values({
      runId: lease.id,
      customerId: lease.customerId,
      sourceId: item.sourceId,
      operationId: item.operationId,
      parameters,
      evidence: item,
      ok: "success",
      latencyMs: 1,
    });
    // A label reaching the store in the answer itself is dropped before it is written.
    expect(
      await aStore.succeed(lease.id, lease.leaseToken!, {
        ...answer,
        evidence: [{ ...item, label: "Not stored" }],
      }),
    ).toBe(true);
    const [stored] = await handles[0]!.db
      .select({ answer: askRuns.answer })
      .from(askRuns)
      .where(eq(askRuns.id, lease.id));
    expect(JSON.stringify(stored!.answer)).not.toContain("label");
    const [message] = await handles[0]!.db
      .select({ answer: askMessages.answer })
      .from(askMessages)
      .where(eq(askMessages.runId, lease.id));
    expect(JSON.stringify(message!.answer)).not.toContain("label");
    expect((await request(a, alice, `/runs/${submitted.body.id}`)).body.answer!.evidence).toEqual([
      { ...item, label },
    ]);
    const detail = (await request(replica, alice, `/chats/${id}`)).body;
    expect(detail.messages.find((m) => m.role === "assistant")!.answer!.evidence).toEqual([
      { ...item, label },
    ]);
  });

  it.each(["completion", "heartbeat"])(
    "cannot use a lease that expires while waiting for a database lock (%s)",
    async (action) => {
      const id = await chat();
      await submit(a, alice, id);
      const lease = (await aStore.claim(100))!;
      let locked!: () => void;
      let release!: () => void;
      const hasLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const untilRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = handles[1]!.db.transaction(async (tx) => {
        await tx
          .select({ id: askRuns.id })
          .from(askRuns)
          .where(eq(askRuns.id, lease.id))
          .for("update");
        locked();
        await untilRelease;
      });
      await hasLock;
      const finishing =
        action === "completion"
          ? aStore.succeed(lease.id, lease.leaseToken!, answer)
          : aStore.heartbeat(lease.id, lease.leaseToken!, 1000);
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      await blocker;
      expect(await finishing).toBe(false);
      expect(await aStore.heartbeat(lease.id, lease.leaseToken!, 1000)).toBe(false);
      expect((await request(a, alice, `/chats/${id}`)).body.messages).toHaveLength(1);
    },
  );

  it("persists preferences/history through a fresh API instance and scopes paging/search cursors", async () => {
    const first = await chat();
    await chat();
    await chat();
    expect(
      (
        await request(a, alice, "/preferences", "PATCH", {
          view: "full",
          chatId: first,
          returnTo: "/upstreams",
        })
      ).status,
    ).toBe(200);
    const freshHandle = createDb(databaseUrl!);
    handles.push(freshHandle);
    const fresh = await server(freshHandle, "customer-a", admission);
    expect((await request(fresh, alice, "/preferences")).body).toEqual({
      view: "full",
      chatId: first,
      returnTo: "/upstreams",
    });
    for (const returnTo of ["/account", "/team", "/audit"]) {
      expect(
        (
          await request(a, alice, "/preferences", "PATCH", {
            view: "panel",
            chatId: first,
            returnTo,
          })
        ).status,
      ).toBe(200);
      expect((await request(fresh, alice, "/preferences")).body.returnTo).toBe(returnTo);
    }
    const page = await request(fresh, alice, "/chats?limit=2");
    expect(page.body.chats).toHaveLength(2);
    const older = await request(a, alice, `/chats?limit=2&cursor=${page.body.nextCursor}`);
    expect(older.body.chats).toHaveLength(1);
    expect(
      new Set([...page.body.chats, ...older.body.chats].map((c: { id: string }) => c.id)).size,
    ).toBe(3);
    expect((await request(b, alice, `/chats?cursor=${page.body.nextCursor}`)).status).toBe(400);
    expect((await request(a, bob, `/chats?cursor=${page.body.nextCursor}`)).status).toBe(400);
    expect((await request(a, alice, "/chats?cursor=garbage")).status).toBe(400);
  });

  it("SQL constraints independently reject a second active run and mismatched message ownership", async () => {
    const id = await chat();
    await submit(a, alice, id);
    const [run] = await handles[0]!.db.select().from(askRuns);
    const { id: _id, ...copy } = run!;
    await expect(
      handles[1]!.db
        .insert(askRuns)
        .values({ ...copy, id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }),
    ).rejects.toThrow();
    await expect(
      handles[1]!.db.insert(askMessages).values({
        runId: run!.id,
        chatId: id,
        customerId: "customer-a",
        ownerId: bob.id,
        role: "assistant",
        answer,
      }),
    ).rejects.toThrow();
  });

  it("hides expired history immediately and rejects browser-selected customer overrides", async () => {
    const id = await chat();
    await submit(a, alice, id);
    await handles[0]!.db
      .update(askChats)
      .set({ expiresAt: new Date(0) })
      .where(eq(askChats.id, id));
    expect((await request(a, alice, `/chats/${id}`)).status).toBe(404);
    expect((await request(a, alice, "/chats")).body.chats).toEqual([]);
    const next = await chat(a, bob);
    expect(
      (
        await request(a, bob, `/chats/${next}/runs`, "POST", {
          idempotencyKey: crypto.randomUUID(),
          question: "Read another customer",
          tenantId: "customer-b",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(a, bob, "/preferences", "PATCH", {
          view: "full",
          chatId: next,
          returnTo: "https://evil.test",
        })
      ).status,
    ).toBe(400);
  });

  it("immediately refuses a revoked session and recovers its queued run", async () => {
    const person = await actor();
    const id = await chat(a, person);
    const run = await submit(a, person, id);
    await revokeSession(handles[0]!.db, person.sessionId, { reason: "self" });
    expect((await request(replica, person, `/runs/${run.body.id}`)).status).toBe(401);
    expect(await replicaStore.recover(120_000)).toBe(1);
    expect(await aStore.getRun(person.id, run.body.id)).toMatchObject({
      status: "interrupted",
      answer: null,
    });
  });

  it("paginates ordered messages without gaps and rejects a cursor from another chat", async () => {
    const id = await chat();
    for (let i = 0; i < 26; i++) {
      await aStore.submit(
        alice.id,
        alice.sessionId,
        id,
        { idempotencyKey: crypto.randomUUID(), question: `Fixture question ${i}` },
        admission,
      );
      const lease = (await replicaStore.claim(10_000))!;
      expect(await aStore.succeed(lease.id, lease.leaseToken!, answer)).toBe(true);
    }
    const page = await request(a, alice, `/chats/${id}`);
    expect(page.body.messages).toHaveLength(50);
    expect(page.body.nextMessageCursor).toBeTruthy();
    const older = await request(
      replica,
      alice,
      `/chats/${id}?before=${page.body.nextMessageCursor}`,
    );
    expect(older.body.messages).toHaveLength(2);
    expect(new Set([...older.body.messages, ...page.body.messages].map((m) => m.id)).size).toBe(52);
    expect(older.body.messages[0]!.question).toBe("Fixture question 0");
    expect(page.body.messages.at(-1)!.role).toBe("assistant");
    const other = await chat();
    expect(
      (await request(a, alice, `/chats/${other}?before=${page.body.nextMessageCursor}`)).status,
    ).toBe(400);
  });

  it("fails closed when real budget admission is absent", async () => {
    const disabled = await server(handles[0]!, "customer-a");
    const id = await chat(disabled);
    expect((await request(disabled, alice, "/capabilities")).body.acceptingQuestions).toBe(false);
    expect((await submit(disabled, alice, id)).status).toBe(503);
    expect(await aStore.activeRun(alice.id)).toBeNull();
  });

  it("does not resurrect expired answers through an idempotent retry", async () => {
    const id = await chat();
    const key = crypto.randomUUID();
    const submitted = await submit(a, alice, id, key);
    const lease = (await aStore.claim(10_000))!;
    expect(await aStore.succeed(lease.id, lease.leaseToken!, answer)).toBe(true);
    await handles[0]!.db
      .update(askRuns)
      .set({ expiresAt: new Date(0) })
      .where(eq(askRuns.id, submitted.body.id));
    expect((await submit(replica, alice, id, key)).status).toBe(404);
    expect((await request(a, alice, `/chats/${id}`)).body.messages).toEqual([]);
  });
  function accounting(index = 0, customerId = "customer-a", limit = 1000n) {
    const settings = { ...readAskSettings(), customerId, retentionDays: 90 };
    return new AskBudget(handles[index]!.db, settings, {
      monthlyLimitMicroUsd: limit,
      counter: { mode: "runtime", model: "anthropic.fixture" },
      pricing: {
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
      },
    });
  }
  it("atomically reserves one shared pool under twelve competing people/replicas", async () => {
    const money = [accounting(0), accounting(1)];
    const paidApi = await server(handles[0]!, "customer-a", money[0]!.admit);
    const runs = [];
    for (let i = 0; i < 12; i++) {
      const person = await actor();
      const id = await chat(paidApi, person);
      const response = await submit(paidApi, person, id);
      expect(response.status).toBe(200);
      const claimed = await aStore.claim(60_000);
      expect(claimed).not.toBeNull();
      runs.push(claimed!);
    }
    const reservations = await Promise.allSettled(
      runs.map((run, index) =>
        money[index % 2]!.reserve(run, 200, 50, index % 2 ? "investigate" : "ask"),
      ),
    );
    expect(reservations.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of reservations)
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "ASK_BUDGET_BUSY" });
    const [pool] = await handles[0]!.db.select().from(askBudgetMonths);
    expect(pool).toMatchObject({ reservedMicroUsd: 1000n, spentMicroUsd: 0n });
    expect(await handles[0]!.db.select().from(askModelSteps)).toHaveLength(2);
  });
  it("denies exhausted admission atomically over HTTP without storing a prompt", async () => {
    const blocked = await server(handles[0]!, "customer-a", accounting(0, "customer-a", 0n).admit);
    const id = await chat(blocked, alice);
    const response = await submit(blocked, alice, id);
    expect(response).toMatchObject({ status: 429, body: { code: "ASK_BUDGET_LIMIT" } });
    expect(await handles[0]!.db.select().from(askRuns)).toHaveLength(0);
    expect(await handles[0]!.db.select().from(askMessages)).toHaveLength(0);
  });
  it("settles concurrent duplicate late receipts once after cancellation while another customer stays open", async () => {
    const first = accounting(0);
    const second = accounting(1);
    const paidApi = await server(handles[0]!, "customer-a", first.admit);
    const id = await chat(paidApi, alice);
    const response = await submit(paidApi, alice, id);
    expect(response.status).toBe(200);
    const run = (await aStore.claim(60_000))!;
    const step = await first.reserve(run, 100, 50);
    await first.dispatched(run, step);
    const otherChat = await chat(b, bob);
    const other = await submit(b, bob, otherChat);
    expect(other.status).toBe(200);
    await request(paidApi, alice, `/runs/${run.id}/cancel`, "POST");
    await aStore.fail(run.id, run.leaseToken!, "ASK_CANCELLED");
    await second.reconcile(run.id);
    const receipt = { requestId: "late-synthetic-receipt", providerStatus: 200 };
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    await Promise.all([
      first.usage(run.id, step, usage, receipt),
      second.usage(run.id, step, usage, receipt),
    ]);
    const [pool] = await handles[0]!.db.select().from(askBudgetMonths);
    expect(pool).toMatchObject({ spentMicroUsd: 20n, reservedMicroUsd: 0n });
    expect((await request(b, bob, `/runs/${other.body.id}`)).body.status).toBe("queued");
    expect((await request(paidApi, alice, `/runs/${run.id}`)).body.status).toBe("cancelled");
  });
  it("keeps a dispatched reservation across retention deletion and settles a later receipt", async () => {
    const money = accounting(0);
    const paidApi = await server(handles[0]!, "customer-a", money.admit);
    const id = await chat(paidApi, alice);
    expect((await submit(paidApi, alice, id)).status).toBe(200);
    const run = (await aStore.claim(60_000))!;
    const step = await money.reserve(run, 100, 50);
    await money.dispatched(run, step);
    await aStore.fail(run.id, run.leaseToken!, "ASK_INTERRUPTED");
    await money.reconcile(run.id);
    await handles[0]!.db
      .update(askRuns)
      .set({ expiresAt: new Date(0) })
      .where(eq(askRuns.id, run.id));
    expect(await new AskRetention(handles[1]!.db, "customer-a", 30).sweep(0)).toBe(1);
    expect(await handles[0]!.db.select().from(askRuns)).toHaveLength(0);
    expect((await handles[0]!.db.select().from(askBudgetMonths))[0]?.reservedMicroUsd).toBe(300n);
    await money.usage(
      run.id,
      step,
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { requestId: "after-retention", providerStatus: 200 },
    );
    expect((await handles[0]!.db.select().from(askBudgetMonths))[0]).toMatchObject({
      spentMicroUsd: 20n,
      reservedMicroUsd: 0n,
    });
  });
  it("redacts credential text before the HTTP submission reaches PostgreSQL", async () => {
    const money = accounting(0);
    const paidApi = await server(handles[0]!, "customer-a", money.admit);
    const id = await chat(paidApi, alice);
    const response = await submit(
      paidApi,
      alice,
      id,
      crypto.randomUUID(),
      "Check token Bearer private-test-credential-123456 and https://example.test/private?api_key=secret",
    );
    expect(response.status).toBe(200);
    const [row] = await handles[0]!.db.select().from(askRuns);
    expect(row!.question).not.toContain("private-test-credential");
    expect(row!.question).not.toContain("api_key=secret");
    expect(row!.question).toContain("[redacted]");
    const detail = await request(paidApi, alice, `/chats/${id}`);
    expect(JSON.stringify(detail.body)).not.toContain("private-test-credential");
  });
  it("isolates opaque browser cache scopes by current person and customer", async () => {
    const aa = await request(a, alice, "/capabilities");
    const ab = await request(a, bob, "/capabilities");
    const ba = await request(b, alice, "/capabilities");
    const same = await request(replica, alice, "/capabilities");
    expect(aa.status).toBe(200);
    expect(aa.body.scopeId).toMatch(/^[a-f0-9]{64}$/);
    expect(same.body.scopeId).toBe(aa.body.scopeId);
    expect(new Set([aa.body.scopeId, ab.body.scopeId, ba.body.scopeId]).size).toBe(3);
    expect(Object.keys(aa.body).sort()).toEqual([
      "acceptingQuestions",
      "canSwitch",
      "contractVersion",
      "enabled",
      "off",
      "scopeId",
    ]);
  });
  it("supports body-based personal search and retained context/error outcomes after reload", async () => {
    const id = await chat();
    const context = {
      page: "metrics",
      chain: "ETH1",
      from: "2026-11-16T10:00:00Z",
      to: "2026-11-16T10:30:00Z",
    };
    const submitted = await request(a, alice, `/chats/${id}/runs`, "POST", {
      idempotencyKey: crypto.randomUUID(),
      question: "PERSONAL_POST_SEARCH_FIXTURE",
      context,
    });
    expect(submitted.status).toBe(200);
    await request(a, alice, `/runs/${submitted.body.id}/cancel`, "POST");
    const detail = await request(replica, alice, `/chats/${id}`);
    expect(detail.body.context).toEqual(context);
    expect(detail.body.runs).toEqual([
      expect.objectContaining({
        id: submitted.body.id,
        status: "cancelled",
        error: expect.objectContaining({ code: "ASK_CANCELLED" }),
      }),
    ]);
    const own = await request(a, alice, "/chats/search", "POST", {
      query: "PERSONAL_POST_SEARCH_FIXTURE",
    });
    expect(own.status).toBe(200);
    expect(own.body.chats.map((c) => c.id)).toEqual([id]);
    for (const [target, person] of [
      [a, bob],
      [b, alice],
    ] as const)
      expect(
        (
          await request(target, person, "/chats/search", "POST", {
            query: "PERSONAL_POST_SEARCH_FIXTURE",
          })
        ).body.chats,
      ).toHaveLength(0);
  });
});
