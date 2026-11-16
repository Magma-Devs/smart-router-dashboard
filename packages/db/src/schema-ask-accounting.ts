import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { askRuns } from "./schema-ask.js";

const time = (name: string) => timestamp(name, { withTimezone: true });

/** Shared by every AI entry point. Financial totals have no prompt/person fields
 * and survive content retention; deleting a chat must never reset spending. */
export const askBudgetMonths = pgTable(
  "ask_budget_months",
  {
    customerId: text("customer_id").notNull(),
    month: text("month").notNull(),
    limitMicroUsd: bigint("limit_micro_usd", { mode: "bigint" }).notNull(),
    reservedMicroUsd: bigint("reserved_micro_usd", { mode: "bigint" }).notNull().default(0n),
    spentMicroUsd: bigint("spent_micro_usd", { mode: "bigint" }).notNull().default(0n),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.month] }),
    check("ask_budget_month", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "ask_budget_nonnegative",
      sql`${t.limitMicroUsd} >= 0 and ${t.reservedMicroUsd} >= 0 and ${t.spentMicroUsd} >= 0`,
    ),
  ],
);

export const askModelSteps = pgTable(
  "ask_model_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Deliberately no FK to retained content or an auth user/session.
    runId: uuid("run_id").notNull(),
    customerId: text("customer_id").notNull(),
    month: text("month").notNull(),
    feature: text("feature").$type<"ask" | "investigate">().notNull(),
    state: text("state")
      .$type<"reserved" | "dispatched" | "uncertain" | "settled" | "released">()
      .notNull(),
    inputTokenBound: integer("input_token_bound").notNull(),
    outputTokenBound: integer("output_token_bound").notNull(),
    reservedMicroUsd: bigint("reserved_micro_usd", { mode: "bigint" }).notNull(),
    chargedMicroUsd: bigint("charged_micro_usd", { mode: "bigint" }),
    pricing: jsonb("pricing").$type<Record<string, unknown>>().notNull(),
    usage: jsonb("usage").$type<Record<string, unknown>>(),
    providerRequestId: text("provider_request_id"),
    providerStatus: integer("provider_status"),
    createdAt: time("created_at").notNull().defaultNow(),
    dispatchedAt: time("dispatched_at"),
    completedAt: time("completed_at"),
  },
  (t) => [
    foreignKey({
      columns: [t.customerId, t.month],
      foreignColumns: [askBudgetMonths.customerId, askBudgetMonths.month],
    }),
    index("ask_model_steps_run").on(t.customerId, t.runId),
    index("ask_model_steps_unresolved").on(t.customerId, t.state, t.createdAt),
    check(
      "ask_step_state",
      sql`${t.state} in ('reserved','dispatched','uncertain','settled','released')`,
    ),
    check("ask_step_feature", sql`${t.feature} in ('ask','investigate')`),
    check(
      "ask_step_nonnegative",
      sql`${t.inputTokenBound} >= 0 and ${t.outputTokenBound} > 0 and ${t.reservedMicroUsd} > 0 and (${t.chargedMicroUsd} is null or ${t.chargedMicroUsd} >= 0)`,
    ),
    check(
      "ask_step_charged",
      sql`(${t.state} in ('settled','released')) = (${t.chargedMicroUsd} is not null)`,
    ),
  ],
);

export const askToolEvents = pgTable(
  "ask_tool_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    customerId: text("customer_id").notNull(),
    sourceId: text("source_id").notNull(),
    operationId: text("operation_id").notNull(),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    ok: text("outcome").$type<"success" | "unavailable">().notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.runId, t.customerId],
      foreignColumns: [askRuns.id, askRuns.customerId],
    }).onDelete("cascade"),
    index("ask_tool_events_run").on(t.customerId, t.runId),
  ],
);

export const askMaintenance = pgTable("ask_maintenance", {
  customerId: text("customer_id").primaryKey(),
  lastAttemptAt: time("last_attempt_at"),
  lastSuccessAt: time("last_success_at"),
  deletedRuns: integer("deleted_runs").notNull().default(0),
  errorCode: text("error_code"),
});

export type AskModelStepRow = typeof askModelSteps.$inferSelect;

export const askStaffAccess = pgTable(
  "ask_staff_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: text("customer_id").notNull(),
    subject: text("subject").notNull(),
    action: text("action").$type<"read" | "export" | "health">().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [index("ask_staff_access_retention").on(t.customerId, t.createdAt)],
);
