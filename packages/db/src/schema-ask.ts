import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AskAnswer, AskErrorCode, AskPageContext, AskRunStatus } from "@sr/shared";
import { users } from "./schema.js";

const time = (name: string) => timestamp(name, { withTimezone: true });

export const askChats = pgTable(
  "ask_chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    activitySeq: bigint("activity_seq", { mode: "bigint" })
      .notNull()
      .default(sql`nextval('ask_chat_activity_seq')`),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    expiresAt: time("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("ask_chats_owned").on(t.id, t.customerId, t.ownerId),
    index("ask_chats_history").on(t.customerId, t.ownerId, t.activitySeq),
    index("ask_chats_expiry").on(t.expiresAt),
    check("ask_chats_title", sql`length(${t.title}) between 1 and 120`),
  ],
);

export const askRuns = pgTable(
  "ask_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id").notNull(),
    customerId: text("customer_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    question: text("question").notNull(),
    context: jsonb("context").$type<AskPageContext | null>(),
    status: text("status").$type<AskRunStatus>().notNull().default("queued"),
    leaseToken: uuid("lease_token"),
    leaseUntil: time("lease_until"),
    attempts: integer("attempts").notNull().default(0),
    answer: jsonb("answer").$type<AskAnswer | null>(),
    errorCode: text("error_code").$type<AskErrorCode | null>(),
    createdAt: time("created_at").notNull().defaultNow(),
    startedAt: time("started_at"),
    completedAt: time("completed_at"),
    expiresAt: time("expires_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "ask_runs_chat_owner",
      columns: [t.chatId, t.customerId, t.ownerId],
      foreignColumns: [askChats.id, askChats.customerId, askChats.ownerId],
    }).onDelete("cascade"),
    uniqueIndex("ask_runs_owned").on(t.id, t.chatId, t.customerId, t.ownerId),
    uniqueIndex("ask_runs_customer").on(t.id, t.customerId),
    uniqueIndex("ask_runs_idempotency").on(t.customerId, t.ownerId, t.idempotencyKey),
    uniqueIndex("ask_runs_one_active_person")
      .on(t.customerId, t.ownerId)
      .where(sql`${t.status} in ('queued','running','cancelling')`),
    index("ask_runs_queue").on(t.customerId, t.status, t.createdAt),
    index("ask_runs_expired_lease").on(t.customerId, t.leaseUntil),
    check("ask_runs_question", sql`length(${t.question}) between 1 and 4000`),
    check(
      "ask_runs_state",
      sql`${t.status} in ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')`,
    ),
    check(
      "ask_runs_terminal",
      sql`(${t.status} in ('queued','running','cancelling')) = (${t.completedAt} is null)`,
    ),
    check("ask_runs_answer", sql`(${t.status} = 'succeeded') = (${t.answer} is not null)`),
    check(
      "ask_runs_lease",
      sql`(${t.status} in ('running','cancelling')) = (${t.leaseToken} is not null and ${t.leaseUntil} is not null)`,
    ),
  ],
);

export const askMessages = pgTable(
  "ask_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigserial("seq", { mode: "bigint" }).notNull(),
    runId: uuid("run_id").notNull(),
    chatId: uuid("chat_id").notNull(),
    customerId: text("customer_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    question: text("question"),
    answer: jsonb("answer").$type<AskAnswer | null>(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "ask_messages_run_owner",
      columns: [t.runId, t.chatId, t.customerId, t.ownerId],
      foreignColumns: [askRuns.id, askRuns.chatId, askRuns.customerId, askRuns.ownerId],
    }).onDelete("cascade"),
    uniqueIndex("ask_messages_turn").on(t.runId, t.role),
    index("ask_messages_chat").on(t.customerId, t.ownerId, t.chatId, t.seq),
    check(
      "ask_messages_content",
      sql`(${t.role}='user' and ${t.question} is not null and ${t.answer} is null) or (${t.role}='assistant' and ${t.answer} is not null and ${t.question} is null)`,
    ),
  ],
);

export const askPreferences = pgTable(
  "ask_preferences",
  {
    customerId: text("customer_id").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    view: text("view").$type<"panel" | "full">().notNull(),
    chatId: uuid("chat_id"),
    returnTo: text("return_to")
      .$type<
        "/overview" | "/dashboard" | "/metrics" | "/upstreams" | "/team" | "/audit" | "/account"
      >()
      .notNull(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.ownerId] }),
    check("ask_preferences_view", sql`${t.view} in ('panel','full')`),
    check(
      "ask_preferences_return_to",
      sql`${t.returnTo} in ('/overview','/dashboard','/metrics','/upstreams','/team','/audit','/account')`,
    ),
  ],
);

export type AskChatRow = typeof askChats.$inferSelect;
export type AskRunRow = typeof askRuns.$inferSelect;
