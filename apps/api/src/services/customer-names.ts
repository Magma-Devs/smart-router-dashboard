import { and, eq, ne, sql } from "drizzle-orm";
import { createAuditWriter, customerNames, type AuditViolation, type Database } from "@sr/db";
import { AUDIT_NONE, auditText, sameCustomerName } from "@sr/shared";

/** Every named customer-id, id → name. */
export async function readCustomerNames(db: Database): Promise<Map<string, string>> {
  const rows = await db
    .select({ customer: customerNames.customer, name: customerNames.name })
    .from(customerNames);
  return new Map(rows.map((row) => [row.customer, row.name]));
}

/** Every named customer-id with when its name last changed. */
export async function listCustomerNames(
  db: Database,
): Promise<{ customer: string; name: string; changedAt: Date }[]> {
  return db
    .select({
      customer: customerNames.customer,
      name: customerNames.name,
      changedAt: customerNames.changedAt,
    })
    .from(customerNames);
}

export type SetCustomerNameResult =
  | { ok: true; changed: boolean }
  /** Another id has this name, or the name is itself a customer-id. */
  | { ok: false; reason: "name-taken" | "name-is-an-id" };

interface Change {
  customer: string;
  actorId: string;
  onViolation: (violation: AuditViolation) => void;
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Names `customer`, or renames it, in one transaction with its audit row. A
 * name another id holds, in any case, is refused; so is a name that is a
 * customer-id itself, one stored here or one in `otherIds` (the ids the
 * routers counted), since Ask reads an id before a name.
 */
export async function setCustomerName(
  db: Database,
  input: Change & { name: string; otherIds?: Iterable<string> },
): Promise<SetCustomerNameResult> {
  for (const id of input.otherIds ?? [])
    if (id !== input.customer && sameCustomerName(id, input.name))
      return { ok: false, reason: "name-is-an-id" };
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ name: customerNames.name })
        .from(customerNames)
        .where(eq(customerNames.customer, input.customer))
        .for("update");
      const [clash] = await tx
        .select({ customer: customerNames.customer, name: customerNames.name })
        .from(customerNames)
        .where(
          and(
            ne(customerNames.customer, input.customer),
            sql`(lower(${customerNames.name}) = lower(${input.name}) or lower(${customerNames.customer}) = lower(${input.name}))`,
          ),
        )
        .limit(1);
      if (clash)
        return {
          ok: false as const,
          reason: sameCustomerName(clash.name, input.name)
            ? ("name-taken" as const)
            : ("name-is-an-id" as const),
        };
      if (before?.name === input.name) return { ok: true as const, changed: false };
      await tx
        .insert(customerNames)
        .values({ customer: input.customer, name: input.name, changedBy: input.actorId })
        .onConflictDoUpdate({
          target: customerNames.customer,
          set: { name: input.name, changedBy: input.actorId, changedAt: sql`now()` },
        });
      await createAuditWriter(db, { onViolation: input.onViolation }).write(
        {
          action: "customer.named",
          actor: { id: input.actorId, kind: "user" },
          target: { type: "customer", id: input.customer, name: input.name },
          changes: [{ field: "name", from: auditText(before?.name), to: input.name }],
        },
        tx,
      );
      return { ok: true as const, changed: true };
    });
  } catch (error) {
    // Two admins giving two ids one name at once: the index decides.
    if (isUniqueViolation(error)) return { ok: false, reason: "name-taken" };
    throw error;
  }
}

/** Clears `customer`'s name, with its audit row; `changed` is false when it had none. */
export async function clearCustomerName(
  db: Database,
  input: Change,
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(customerNames)
      .where(eq(customerNames.customer, input.customer))
      .returning({ name: customerNames.name });
    if (!removed) return { changed: false };
    await createAuditWriter(db, { onViolation: input.onViolation }).write(
      {
        action: "customer.name_cleared",
        actor: { id: input.actorId, kind: "user" },
        target: { type: "customer", id: input.customer, name: removed.name },
        changes: [{ field: "name", from: removed.name, to: AUDIT_NONE }],
      },
      tx,
    );
    return { changed: true };
  });
}
