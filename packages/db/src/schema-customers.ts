import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./schema.js";

/**
 * customer_names — the names this deployment's admins give the customer-id
 * values its callers send. One row per named id; an id without a row shows as
 * itself. Two ids never share a name, whatever its case.
 */
export const customerNames = pgTable(
  "customer_names",
  {
    /** The customer-id value exactly as the router counts it. */
    customer: text("customer").primaryKey(),
    name: varchar("name", { length: 64 }).notNull(),
    changedBy: uuid("changed_by").references(() => users.id, { onDelete: "set null" }),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customer_names_name_unique").on(sql`lower(${t.name})`)],
);

export type CustomerNameRow = typeof customerNames.$inferSelect;
