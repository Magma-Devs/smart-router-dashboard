import { and, eq, sql } from "drizzle-orm";
import { askRuns, askSwitch, createAuditWriter, type AuditViolation, type Database } from "@sr/db";
import type { AskTransaction } from "./store.js";

/** SQL that is true while an admin has Ask turned off for this customer. */
export function askTurnedOff(customerId: string) {
  return sql`exists (select 1 from ask_switch w where w.customer_id = ${customerId} and w.off)`;
}

export async function readAskSwitch(db: Database, customerId: string): Promise<boolean> {
  const [row] = await db
    .select({ off: askSwitch.off })
    .from(askSwitch)
    .where(eq(askSwitch.customerId, customerId));
  return row?.off ?? false;
}

/** Inside a submission: the share lock makes a concurrent turn-off wait for the
 * new question, so that turn-off cancels it rather than missing it. */
export async function admittedBySwitch(tx: AskTransaction, customerId: string): Promise<boolean> {
  const [row] = await tx
    .select({ off: askSwitch.off })
    .from(askSwitch)
    .where(eq(askSwitch.customerId, customerId))
    .for("share");
  return !(row?.off ?? false);
}

/**
 * Turns Ask off or on for everyone, in one transaction with its audit row.
 * Turning it off cancels the queued questions and asks every running one to
 * stop; the worker holding a run sees that on its next lease check.
 */
export async function setAskSwitch(
  db: Database,
  customerId: string,
  off: boolean,
  actorId: string,
  onViolation: (violation: AuditViolation) => void,
): Promise<void> {
  await db.transaction(async (tx) => {
    // The row exists before it is locked, so two admins' first clicks queue.
    await tx.insert(askSwitch).values({ customerId, off: false }).onConflictDoNothing();
    const [before] = await tx
      .select({ off: askSwitch.off })
      .from(askSwitch)
      .where(eq(askSwitch.customerId, customerId))
      .for("update");
    const changed = (before?.off ?? false) !== off;
    if (changed)
      await tx
        .update(askSwitch)
        .set({ off, changedBy: actorId, changedAt: sql`now()` })
        .where(eq(askSwitch.customerId, customerId));
    if (off) {
      await tx
        .update(askRuns)
        .set({ status: "cancelled", errorCode: "ASK_CANCELLED", completedAt: sql`now()` })
        .where(and(eq(askRuns.customerId, customerId), eq(askRuns.status, "queued")));
      await tx
        .update(askRuns)
        .set({ status: "cancelling" })
        .where(and(eq(askRuns.customerId, customerId), eq(askRuns.status, "running")));
    }
    if (!changed) return;
    await createAuditWriter(db, { onViolation }).write(
      {
        action: off ? "ask.turned_off" : "ask.turned_on",
        actor: { id: actorId, kind: "user" },
        target: { type: "ask", id: customerId, name: "Ask your data" },
      },
      tx,
    );
  });
}

/**
 * The switch as this replica last read it, for the synchronous readiness check.
 * It counts as off until the first read answers, so a replica that starts while
 * Ask is off never begins work first. Admission, queue claims and paid steps
 * read the row itself.
 */
export class AskSwitchState {
  private known: boolean | null = null;
  constructor(
    private readonly db: Database,
    private readonly customerId: string,
  ) {}

  get off(): boolean {
    return this.known !== false;
  }

  get confirmedOff(): boolean {
    return this.known === true;
  }

  async refresh(): Promise<boolean> {
    this.known = await readAskSwitch(this.db, this.customerId);
    return this.known;
  }

  remember(off: boolean): void {
    this.known = off;
  }
}
