import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  askChats,
  askMessages,
  askModelSteps,
  askPreferences,
  askRuns,
  askToolEvents,
  sessions,
  users,
  type AskChatRow,
  type AskRunRow,
  type Database,
} from "@sr/db";
import {
  askAnswerSchema,
  askHistoryQuerySchema,
  askPreferencesSchema,
  askSubmitSchema,
  type AskAnswer,
  type AskChat,
  type AskChatDetail,
  type AskChatPage,
  type AskErrorCode,
  type AskMessage,
  type AskPreferences,
  type AskRun,
  type AskSubmit,
} from "@sr/shared";
import { AskFailure } from "./errors.js";
import { readLabel, runProgress } from "./progress.js";
import { askTurnedOff } from "./switch.js";

export type AskTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type AskAdmission = (tx: AskTransaction, run: AskRunRow) => Promise<void>;
const active = ["queued", "running", "cancelling"] as const;
const alive = (expiresAt: typeof askChats.expiresAt | typeof askRuns.expiresAt) =>
  gt(expiresAt, sql`now()`);
const defaultPreferences: AskPreferences = { view: "panel", chatId: null, returnTo: "/metrics" };

function chatWire(row: AskChatRow): AskChat {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function runWire(row: AskRunRow): AskRun {
  return {
    id: row.id,
    chatId: row.chatId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    answer: row.answer ? askAnswerSchema.parse(row.answer) : null,
    error: row.errorCode
      ? { code: row.errorCode, message: new AskFailure(row.errorCode).message }
      : null,
  };
}
function messageWire(row: typeof askMessages.$inferSelect): AskMessage {
  return {
    id: row.id,
    runId: row.runId,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    question: row.question,
    answer: row.answer ? askAnswerSchema.parse(row.answer) : null,
  };
}
/** Awaits statements a transaction sent together and settles them in the order
 * they were sent. PostgreSQL runs them in that order and a failure aborts the
 * ones after it, so the first rejection by position is the statement that
 * failed, as if they had been awaited one at a time. */
export async function inOrder<T extends readonly unknown[]>(
  statements: readonly [...{ [K in keyof T]: PromiseLike<T[K]> }],
): Promise<T> {
  const settled = await Promise.allSettled(statements);
  for (const outcome of settled) if (outcome.status === "rejected") throw outcome.reason;
  return settled.map(
    (outcome) => (outcome as PromiseFulfilledResult<unknown>).value,
  ) as unknown as T;
}
/** A stored answer never carries the reads' labels, so an earlier API version
 * still parses it; they are attached from the audited tool events on the way out. */
function storedAnswer(answer: AskAnswer): AskAnswer {
  return { ...answer, evidence: answer.evidence.map(({ label: _label, ...item }) => item) };
}
function labelled(answer: AskAnswer | null, labels: Map<string, string>): AskAnswer | null {
  if (!answer?.evidence.some((item) => labels.has(item.id))) return answer;
  return {
    ...answer,
    evidence: answer.evidence.map((item) =>
      labels.has(item.id) ? { ...item, label: labels.get(item.id)! } : item,
    ),
  };
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function cursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function sequenceCursor(value?: string): { seq: bigint; filter: string } | null {
  if (!value) return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.seq !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(parsed.seq) ||
      BigInt(parsed.seq) > 9223372036854775807n ||
      typeof parsed.filter !== "string"
    )
      throw new Error();
    return { seq: BigInt(parsed.seq), filter: parsed.filter };
  } catch {
    throw new AskFailure("ASK_INVALID_REQUEST", 400);
  }
}

/** One immutable deployment customer scope. Every personal read/mutation also
 * filters the current session's person; IDs/cursors never grant access. */
export class AskStore {
  constructor(
    private readonly db: Database,
    readonly customerId: string,
    private readonly retentionDays: number,
  ) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(customerId) ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 90
    )
      throw new AskFailure("ASK_UNAVAILABLE");
  }

  private chatOwned(personId: string, id?: string) {
    return and(
      eq(askChats.customerId, this.customerId),
      eq(askChats.ownerId, personId),
      id ? eq(askChats.id, id) : undefined,
      alive(askChats.expiresAt),
      gt(askChats.updatedAt, sql`now() - ${this.retentionDays} * interval '1 day'`),
    );
  }
  private runOwned(personId: string, id?: string) {
    return and(
      eq(askRuns.customerId, this.customerId),
      eq(askRuns.ownerId, personId),
      id ? eq(askRuns.id, id) : undefined,
      alive(askRuns.expiresAt),
      gt(askRuns.createdAt, sql`now() - ${this.retentionDays} * interval '1 day'`),
    );
  }
  private expiry() {
    return sql`now() + ${this.retentionDays} * interval '1 day'`;
  }

  async createChat(personId: string): Promise<AskChat> {
    const [row] = await this.db
      .insert(askChats)
      .values({
        customerId: this.customerId,
        ownerId: personId,
        title: "New chat",
        expiresAt: this.expiry(),
      })
      .returning();
    return chatWire(row!);
  }

  async listChats(personId: string, raw: unknown): Promise<AskChatPage> {
    const query = askHistoryQuerySchema.safeParse(raw);
    if (!query.success) throw new AskFailure("ASK_INVALID_REQUEST", 400);
    const filter = fingerprint({
      customer: this.customerId,
      person: personId,
      query: query.data.query ?? "",
    });
    const before = sequenceCursor(query.data.cursor);
    if (before && before.filter !== filter) throw new AskFailure("ASK_INVALID_REQUEST", 400);
    const size = query.data.limit ?? 20;
    const search = query.data.query;
    const pattern = `%${search?.replace(/[\\%_]/g, "\\$&") ?? ""}%`;
    const rows = await this.db
      .select()
      .from(askChats)
      .where(
        and(
          this.chatOwned(personId),
          before ? lt(askChats.activitySeq, before.seq) : undefined,
          search
            ? sql`(${askChats.title} ilike ${pattern} or exists (select 1 from ask_messages m join ask_runs r on r.id=m.run_id where m.chat_id=${askChats.id} and m.customer_id=${this.customerId} and m.owner_id=${personId} and r.expires_at>now() and r.created_at>now()-${this.retentionDays} * interval '1 day' and (m.question ilike ${pattern} or m.answer->>'summary' ilike ${pattern})))`
            : undefined,
        ),
      )
      .orderBy(desc(askChats.activitySeq))
      .limit(size + 1);
    const page = rows.slice(0, size);
    return {
      chats: page.map(chatWire),
      nextCursor:
        rows.length > size ? cursor({ seq: page.at(-1)!.activitySeq.toString(), filter }) : null,
    };
  }

  async chatDetail(personId: string, chatId: string, before?: string): Promise<AskChatDetail> {
    const [chat] = await this.db
      .select()
      .from(askChats)
      .where(this.chatOwned(personId, chatId))
      .limit(1);
    if (!chat) throw new AskFailure("ASK_NOT_FOUND", 404);
    const filter = fingerprint({ customer: this.customerId, person: personId, chat: chatId });
    const pageCursor = sequenceCursor(before);
    if (pageCursor && pageCursor.filter !== filter)
      throw new AskFailure("ASK_INVALID_REQUEST", 400);
    const rows = await this.db
      .select()
      .from(askMessages)
      .where(
        and(
          eq(askMessages.chatId, chatId),
          eq(askMessages.customerId, this.customerId),
          eq(askMessages.ownerId, personId),
          sql`exists (select 1 from ask_runs r where r.id=${askMessages.runId} and r.expires_at>now() and r.created_at>now()-${this.retentionDays} * interval '1 day')`,
          pageCursor ? lt(askMessages.seq, pageCursor.seq) : undefined,
        ),
      )
      .orderBy(desc(askMessages.seq))
      .limit(51);
    const page = rows.slice(0, 50);
    const [run] = await this.db
      .select()
      .from(askRuns)
      .where(
        and(this.runOwned(personId), eq(askRuns.chatId, chatId), inArray(askRuns.status, active)),
      )
      .limit(1);
    const turnIds = [...new Set(page.map((message) => message.runId))];
    const labels = await this.evidenceLabels([...turnIds, ...(run ? [run.id] : [])]);
    const turns = turnIds.length
      ? await this.db
          .select()
          .from(askRuns)
          .where(and(this.runOwned(personId), inArray(askRuns.id, turnIds)))
      : [];
    return {
      chat: chatWire(chat),
      context: turns.find((turn) => turn.id === rows[0]?.runId)?.context ?? null,
      runs: turns.map((turn) => ({
        id: turn.id,
        status: turn.status,
        completedAt: turn.completedAt?.toISOString() ?? null,
        error: turn.errorCode
          ? { code: turn.errorCode, message: new AskFailure(turn.errorCode).message }
          : null,
      })),
      messages: [...page].reverse().map((row) => {
        const message = messageWire(row);
        return { ...message, answer: labelled(message.answer, labels) };
      }),
      activeRun: run ? this.labelledRun(runWire(run), labels) : null,
      nextMessageCursor:
        rows.length > 50 ? cursor({ seq: page.at(-1)!.seq.toString(), filter }) : null,
    };
  }

  /** The retained messages a worker gives a run as history: the newest page
   * `chatDetail` shows, in one round trip. The chat check and the page are
   * read side by side; a chat that is gone fails the run as `chatDetail` does. */
  async history(run: Pick<AskRunRow, "ownerId" | "chatId">): Promise<AskMessage[]> {
    const [chat, rows] = await Promise.all([
      this.db
        .select({ id: askChats.id })
        .from(askChats)
        .where(this.chatOwned(run.ownerId, run.chatId))
        .limit(1),
      this.db
        .select()
        .from(askMessages)
        .where(
          and(
            eq(askMessages.chatId, run.chatId),
            eq(askMessages.customerId, this.customerId),
            eq(askMessages.ownerId, run.ownerId),
            sql`exists (select 1 from ask_runs r where r.id=${askMessages.runId} and r.expires_at>now() and r.created_at>now()-${this.retentionDays} * interval '1 day')`,
          ),
        )
        .orderBy(desc(askMessages.seq))
        .limit(50),
    ]);
    if (!chat[0]) throw new AskFailure("ASK_NOT_FOUND", 404);
    return [...rows].reverse().map(messageWire);
  }

  async getRun(personId: string, runId: string): Promise<AskRun> {
    const [run] = await this.db
      .select()
      .from(askRuns)
      .where(this.runOwned(personId, runId))
      .limit(1);
    if (!run) throw new AskFailure("ASK_NOT_FOUND", 404);
    return this.labelledRun(runWire(run), await this.evidenceLabels([run.id]));
  }

  async activeRun(personId: string): Promise<AskRun | null> {
    const [run] = await this.db
      .select()
      .from(askRuns)
      .where(and(this.runOwned(personId), inArray(askRuns.status, active)))
      .limit(1);
    if (!run) return null;
    const wire = runWire(run);
    if (run.status !== "running")
      return this.labelledRun(wire, await this.evidenceLabels([run.id]));
    // Read-only: the turns and reads the run records as it goes. Both lookups
    // use the (customer, run) indexes and run side by side.
    const [steps, reads] = await Promise.all([
      this.db
        .select({
          state: askModelSteps.state,
          createdAt: askModelSteps.createdAt,
          completedAt: askModelSteps.completedAt,
        })
        .from(askModelSteps)
        .where(and(eq(askModelSteps.customerId, this.customerId), eq(askModelSteps.runId, run.id)))
        .orderBy(askModelSteps.createdAt),
      this.db
        .select({
          operationId: askToolEvents.operationId,
          parameters: askToolEvents.parameters,
          ok: askToolEvents.ok,
          createdAt: askToolEvents.createdAt,
        })
        .from(askToolEvents)
        .where(and(eq(askToolEvents.customerId, this.customerId), eq(askToolEvents.runId, run.id)))
        .orderBy(askToolEvents.createdAt),
    ]);
    return { ...wire, progress: runProgress(steps, reads) };
  }

  /** Each read's label, by evidence id: named from the operation and the query
   * its audited tool event recorded, in the words the progress list uses. */
  private async evidenceLabels(runIds: string[]): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    if (!runIds.length) return labels;
    const rows = await this.db
      .select({
        operationId: askToolEvents.operationId,
        parameters: askToolEvents.parameters,
        evidence: askToolEvents.evidence,
      })
      .from(askToolEvents)
      .where(
        and(eq(askToolEvents.customerId, this.customerId), inArray(askToolEvents.runId, runIds)),
      );
    for (const row of rows) {
      const id = row.evidence.id;
      if (typeof id === "string") labels.set(id, readLabel(row.operationId, row.parameters));
    }
    return labels;
  }

  private labelledRun(run: AskRun, labels: Map<string, string>): AskRun {
    return run.answer ? { ...run, answer: labelled(run.answer, labels) } : run;
  }

  async submit(
    personId: string,
    sessionId: string,
    chatId: string,
    raw: unknown,
    admit: AskAdmission,
  ): Promise<AskRun> {
    const parsed = askSubmitSchema.safeParse(raw);
    if (!parsed.success) throw new AskFailure("ASK_INVALID_REQUEST", 400);
    const request: AskSubmit = parsed.data;
    const requestHash = fingerprint({
      chatId,
      question: request.question,
      context: request.context ?? null,
    });
    return this.db.transaction(async (tx) => {
      // The user row serializes same-person submissions across API replicas.
      // The partial unique index independently enforces the invariant in SQL.
      const [person] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, personId), eq(users.status, "active")))
        .for("update");
      if (!person) throw new AskFailure("ASK_NOT_FOUND", 404);
      // Everything below reads after the lock. One statement asks the four
      // questions a submission checks; they are answered in the order the
      // submission reports them.
      const [found] = await tx
        .select({
          session: sql<string | null>`(${tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.id, sessionId),
                eq(sessions.userId, personId),
                isNull(sessions.revokedAt),
                gt(sessions.expiresAt, sql`clock_timestamp()`),
              ),
            )
            .limit(1)})`,
          chat: sql<string | null>`(${tx
            .select({ id: askChats.id })
            .from(askChats)
            .where(this.chatOwned(personId, chatId))
            .limit(1)})`,
          existing: sql<string | null>`(${tx
            .select({ id: askRuns.id })
            .from(askRuns)
            .where(
              and(
                eq(askRuns.customerId, this.customerId),
                eq(askRuns.ownerId, personId),
                eq(askRuns.idempotencyKey, request.idempotencyKey),
              ),
            )
            .limit(1)})`,
          current: sql<string | null>`(${tx
            .select({ id: askRuns.id })
            .from(askRuns)
            .where(and(this.runOwned(personId), inArray(askRuns.status, active)))
            .limit(1)})`,
        })
        .from(users)
        .where(eq(users.id, personId));
      if (!found?.session) throw new AskFailure("ASK_INTERRUPTED", 409);
      if (!found.chat) throw new AskFailure("ASK_NOT_FOUND", 404);
      if (found.existing) {
        const [existing] = await tx
          .select()
          .from(askRuns)
          .where(eq(askRuns.id, found.existing))
          .limit(1);
        if (existing!.requestHash !== requestHash) throw new AskFailure("ASK_CONFLICT", 409);
        const [visible] = await tx
          .select({ id: askRuns.id })
          .from(askRuns)
          .where(this.runOwned(personId, existing!.id))
          .limit(1);
        if (!visible) throw new AskFailure("ASK_NOT_FOUND", 404);
        return runWire(existing!);
      }
      if (found.current) throw new AskFailure("ASK_ACTIVE_RUN", 409);
      const [run] = await tx
        .insert(askRuns)
        .values({
          id: randomUUID(),
          chatId,
          customerId: this.customerId,
          ownerId: personId,
          sessionId,
          idempotencyKey: request.idempotencyKey,
          requestHash,
          question: request.question,
          context: request.context ?? null,
          expiresAt: this.expiry(),
        })
        .returning();
      await admit(tx, run!);
      await inOrder([
        tx.insert(askMessages).values({
          runId: run!.id,
          chatId,
          customerId: this.customerId,
          ownerId: personId,
          role: "user",
          question: request.question,
        }),
        tx
          .update(askChats)
          .set({
            // Keep a preview of the newest retained question, so an old first
            // question cannot survive its retention period in the chat title.
            title: request.question.slice(0, 120),
            updatedAt: sql`now()`,
            expiresAt: this.expiry(),
            activitySeq: sql`nextval('ask_chat_activity_seq')`,
          })
          .where(this.chatOwned(personId, chatId)),
      ]);
      return runWire(run!);
    });
  }

  async cancel(personId: string, runId: string): Promise<AskRun> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(askRuns)
        .where(this.runOwned(personId, runId))
        .for("update");
      if (!run) throw new AskFailure("ASK_NOT_FOUND", 404);
      if (!active.includes(run.status as (typeof active)[number])) return runWire(run);
      const queued = run.status === "queued";
      const [updated] = await tx
        .update(askRuns)
        .set(
          queued
            ? { status: "cancelled", errorCode: "ASK_CANCELLED", completedAt: sql`now()` }
            : { status: "cancelling" },
        )
        .where(eq(askRuns.id, runId))
        .returning();
      return runWire(updated!);
    });
  }

  async preferences(personId: string): Promise<AskPreferences> {
    const [row] = await this.db
      .select()
      .from(askPreferences)
      .where(
        and(eq(askPreferences.customerId, this.customerId), eq(askPreferences.ownerId, personId)),
      )
      .limit(1);
    if (!row) return { ...defaultPreferences };
    const [chat] = row.chatId
      ? await this.db
          .select({ id: askChats.id })
          .from(askChats)
          .where(this.chatOwned(personId, row.chatId))
          .limit(1)
      : [];
    return { view: row.view, returnTo: row.returnTo, chatId: chat?.id ?? null };
  }

  async savePreferences(personId: string, raw: unknown): Promise<AskPreferences> {
    const parsed = askPreferencesSchema.safeParse(raw);
    if (!parsed.success) throw new AskFailure("ASK_INVALID_REQUEST", 400);
    if (parsed.data.chatId) await this.chatDetail(personId, parsed.data.chatId);
    await this.db
      .insert(askPreferences)
      .values({ customerId: this.customerId, ownerId: personId, ...parsed.data })
      .onConflictDoUpdate({
        target: [askPreferences.customerId, askPreferences.ownerId],
        set: { ...parsed.data, updatedAt: sql`now()` },
      });
    return parsed.data;
  }

  /** Claims the oldest queued run younger than `maxAgeMs`; an older one is
   * left for `recover`, which fails it as timed out. */
  async claim(leaseMs: number, maxAgeMs?: number): Promise<AskRunRow | null> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 120_000)
      throw new AskFailure("ASK_UNAVAILABLE");
    if (maxAgeMs !== undefined && (!Number.isInteger(maxAgeMs) || maxAgeMs < 1))
      throw new AskFailure("ASK_UNAVAILABLE");
    // One statement: the scalar subquery runs once, locks the oldest claimable
    // run (skipping any another replica holds) and the update takes that row.
    const next = this.db
      .select({ id: askRuns.id })
      .from(askRuns)
      .where(
        and(
          eq(askRuns.customerId, this.customerId),
          eq(askRuns.status, "queued"),
          alive(askRuns.expiresAt),
          maxAgeMs === undefined
            ? undefined
            : sql`${askRuns.createdAt} >= clock_timestamp() - ${maxAgeMs} * interval '1 millisecond'`,
          this.sessionActive(),
          sql`not ${askTurnedOff(this.customerId)}`,
        ),
      )
      .orderBy(askRuns.createdAt, askRuns.id)
      .limit(1)
      .for("update", { skipLocked: true });
    const [claimed] = await this.db
      .update(askRuns)
      .set({
        status: "running",
        leaseToken: randomUUID(),
        leaseUntil: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`,
        startedAt: sql`now()`,
        attempts: sql`${askRuns.attempts}+1`,
      })
      .where(eq(askRuns.id, sql`(${next})`))
      .returning();
    return claimed ?? null;
  }

  private lease(runId: string, token: string) {
    return and(
      eq(askRuns.customerId, this.customerId),
      eq(askRuns.id, runId),
      eq(askRuns.leaseToken, token),
      gt(askRuns.leaseUntil, sql`clock_timestamp()`),
      inArray(askRuns.status, ["running", "cancelling"]),
      alive(askRuns.expiresAt),
    );
  }

  private sessionActive() {
    return sql`exists (select 1 from ${sessions} s join ${users} u on u.id=s.user_id where s.id=${askRuns.sessionId} and s.user_id=${askRuns.ownerId} and s.revoked_at is null and s.expires_at > clock_timestamp() and u.status='active')`;
  }

  private async lockLease(tx: AskTransaction, runId: string, token: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: askRuns.id })
      .from(askRuns)
      .where(
        and(
          eq(askRuns.customerId, this.customerId),
          eq(askRuns.id, runId),
          eq(askRuns.leaseToken, token),
          inArray(askRuns.status, ["running", "cancelling"]),
        ),
      )
      .for("update");
    return Boolean(row);
  }

  async heartbeat(runId: string, token: string, leaseMs: number): Promise<boolean> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 120_000)
      throw new AskFailure("ASK_UNAVAILABLE");
    return this.db.transaction(async (tx) => {
      if (!(await this.lockLease(tx, runId, token))) return false;
      // Re-evaluate wall time AFTER a lock wait. A single UPDATE can evaluate
      // a volatile WHERE predicate before waiting on a SELECT FOR UPDATE lock.
      const rows = await tx
        .update(askRuns)
        .set({ leaseUntil: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'` })
        .where(and(this.lease(runId, token), this.sessionActive()))
        .returning({ id: askRuns.id });
      return rows.length === 1;
    });
  }

  /** The worker's lease check: one renewal that also reads the run's status.
   * A running run's lease is extended; a cancelling run keeps its lease and
   * reads `cancelling`; anything else, a revoked session included, is `lost`. */
  async renew(
    runId: string,
    token: string,
    leaseMs: number,
  ): Promise<"running" | "cancelling" | "lost"> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 120_000)
      throw new AskFailure("ASK_UNAVAILABLE");
    return this.db.transaction(async (tx) => {
      // The lock and the update go together. The update is its own statement,
      // so it re-evaluates wall time AFTER the lock wait, as `heartbeat` does,
      // and its own lease condition matches nothing when the lock found nothing.
      const [locked, [row]] = await inOrder([
        this.lockLease(tx, runId, token),
        tx
          .update(askRuns)
          .set({
            leaseUntil: sql`case when ${askRuns.status}='running' then clock_timestamp() + ${leaseMs} * interval '1 millisecond' else ${askRuns.leaseUntil} end`,
          })
          .where(and(this.lease(runId, token), this.sessionActive()))
          .returning({ status: askRuns.status }),
      ]);
      if (!locked) return "lost";
      return row?.status === "running" || row?.status === "cancelling" ? row.status : "lost";
    });
  }

  /** A fencing token and current lease prevent a late/crashed worker publishing
   * after cancellation or recovery. No assistant success exists on failure.
   * The message and chat writes go with the update: each writes only when
   * the update took the run, and the transaction keeps the three together. */
  async succeed(
    runId: string,
    token: string,
    raw: AskAnswer,
    run?: Pick<AskRunRow, "chatId" | "customerId" | "ownerId">,
  ): Promise<boolean> {
    const parsed = askAnswerSchema.safeParse(raw);
    if (!parsed.success) throw new AskFailure("ASK_INVALID_ANSWER", 502);
    const answer = storedAnswer(parsed.data);
    return this.db.transaction(async (tx) => {
      const lock = this.lockLease(tx, runId, token);
      if (!run && !(await lock)) return false;
      const update = tx
        .update(askRuns)
        .set({
          status: "succeeded",
          answer,
          completedAt: sql`clock_timestamp()`,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(and(this.lease(runId, token), eq(askRuns.status, "running"), this.sessionActive()))
        .returning();
      // The lease row is locked, so the run reads succeeded with no lease
      // token exactly when the update took it. Given the run, the lock, the
      // update and both writes go together; the update's own lease condition
      // matches nothing when the lock found nothing.
      const took = sql`exists (select 1 from ask_runs r where r.id=${runId} and r.status='succeeded' and r.lease_token is null)`;
      let first: PromiseLike<unknown> = lock;
      let second: PromiseLike<unknown[]> = update;
      if (!run) {
        const updated = await update;
        if (!updated[0]) return false;
        run = updated[0];
        first = Promise.resolve(true);
        second = Promise.resolve(updated);
      }
      const [, updated] = await inOrder([
        first,
        second,
        tx.execute(
          sql`insert into ask_messages (run_id, chat_id, customer_id, owner_id, role, answer) select ${runId}::uuid, ${run.chatId}::uuid, ${run.customerId}, ${run.ownerId}::uuid, 'assistant', ${JSON.stringify(answer)}::jsonb where ${took}`,
        ),
        tx
          .update(askChats)
          .set({ updatedAt: sql`now()`, activitySeq: sql`nextval('ask_chat_activity_seq')` })
          .where(and(eq(askChats.id, run.chatId), took)),
      ]);
      return updated.length === 1;
    });
  }

  async fail(runId: string, token: string, code: AskErrorCode): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if (!(await this.lockLease(tx, runId, token))) return false;
      const rows = await tx
        .update(askRuns)
        .set({
          status: sql`case when ${askRuns.status}='cancelling' or ${code}='ASK_CANCELLED' then 'cancelled' when ${code}='ASK_INTERRUPTED' then 'interrupted' else 'failed' end`,
          errorCode: sql`case when ${askRuns.status}='cancelling' then 'ASK_CANCELLED' else ${code} end`,
          completedAt: sql`now()`,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(this.lease(runId, token))
        .returning({ id: askRuns.id });
      return rows.length === 1;
    });
  }

  /** Never replay an invocation after a lost lease. Usage uncertainty and any
   * financial reservation survive recovery (the accounting slice owns them). */
  async recover(maxAgeMs: number): Promise<number> {
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1) throw new AskFailure("ASK_UNAVAILABLE");
    const revoked = sql`not (${this.sessionActive()})`;
    const timedOut = sql`${askRuns.createdAt} < clock_timestamp() - ${maxAgeMs} * interval '1 millisecond'`;
    const rows = await this.db
      .update(askRuns)
      .set({
        status: sql`case when ${askRuns.status}='cancelling' then 'cancelled' when ${timedOut} then 'failed' else 'interrupted' end`,
        errorCode: sql`case when ${askRuns.status}='cancelling' then 'ASK_CANCELLED' when ${timedOut} then 'ASK_TIMEOUT' else 'ASK_INTERRUPTED' end`,
        completedAt: sql`now()`,
        leaseToken: null,
        leaseUntil: null,
      })
      .where(
        and(
          eq(askRuns.customerId, this.customerId),
          inArray(askRuns.status, active),
          or(lt(askRuns.leaseUntil, sql`clock_timestamp()`), timedOut, revoked),
        ),
      )
      .returning({ id: askRuns.id });
    return rows.length;
  }

  async leaseState(runId: string, token: string): Promise<"running" | "cancelling" | "lost"> {
    const [run] = await this.db
      .select({ status: askRuns.status })
      .from(askRuns)
      .where(and(this.lease(runId, token), this.sessionActive()))
      .limit(1);
    return run?.status === "running" || run?.status === "cancelling" ? run.status : "lost";
  }

  async interruptQueued(): Promise<void> {
    await this.db
      .update(askRuns)
      .set({ status: "interrupted", errorCode: "ASK_INTERRUPTED", completedAt: sql`now()` })
      .where(and(eq(askRuns.customerId, this.customerId), eq(askRuns.status, "queued")));
  }
}
