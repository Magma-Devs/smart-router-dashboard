import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  askChats,
  askMaintenance,
  askPreferences,
  askRuns,
  askStaffAccess,
  type Database,
} from "@sr/db";

/** Retryable, bounded physical deletion. Accounting has no content FK and is
 * intentionally preserved. Readers enforce expiry even if this sweep fails. */
export class AskRetention {
  constructor(
    private readonly db: Database,
    private readonly customerId: string,
    private readonly days: number,
  ) {
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Invalid Ask retention");
  }
  async sweep(minIntervalMs = 60_000): Promise<number> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx
          .insert(askMaintenance)
          .values({ customerId: this.customerId })
          .onConflictDoNothing();
        const [job] = await tx
          .select()
          .from(askMaintenance)
          .where(
            and(
              eq(askMaintenance.customerId, this.customerId),
              sql`(${askMaintenance.lastAttemptAt} is null or ${askMaintenance.lastAttemptAt} <= clock_timestamp() - ${minIntervalMs} * interval '1 millisecond')`,
            ),
          )
          .for("update", { skipLocked: true });
        if (!job) return 0;
        // Recheck in a fresh statement after the lock; concurrent replicas
        // must not all run a sweep based on a stale pre-lock clock.
        const [due] = await tx
          .select({ id: askMaintenance.customerId })
          .from(askMaintenance)
          .where(
            and(
              eq(askMaintenance.customerId, this.customerId),
              sql`(${askMaintenance.lastAttemptAt} is null or ${askMaintenance.lastAttemptAt} <= clock_timestamp() - ${minIntervalMs} * interval '1 millisecond')`,
            ),
          );
        if (!due) return 0;
        const expired = await tx
          .select({ id: askRuns.id })
          .from(askRuns)
          .where(
            and(
              eq(askRuns.customerId, this.customerId),
              inArray(askRuns.status, ["succeeded", "failed", "cancelled", "interrupted"]),
              or(
                sql`${askRuns.expiresAt} <= clock_timestamp()`,
                sql`${askRuns.createdAt} <= clock_timestamp() - ${this.days} * interval '1 day'`,
              ),
            ),
          )
          .limit(500)
          .for("update", { skipLocked: true });
        if (expired.length)
          await tx.delete(askRuns).where(
            and(
              eq(askRuns.customerId, this.customerId),
              inArray(
                askRuns.id,
                expired.map((r) => r.id),
              ),
            ),
          );
        // Cascades remove messages and tool parameters with their run.
        const empty = await tx
          .select({ id: askChats.id })
          .from(askChats)
          .where(
            and(
              eq(askChats.customerId, this.customerId),
              sql`not exists(select 1 from ask_runs r where r.chat_id=${askChats.id})`,
              or(
                sql`${askChats.expiresAt} <= clock_timestamp()`,
                sql`${askChats.updatedAt} <= clock_timestamp() - ${this.days} * interval '1 day'`,
              ),
            ),
          )
          .limit(500)
          .for("update", { skipLocked: true });
        if (empty.length)
          await tx.delete(askChats).where(
            and(
              eq(askChats.customerId, this.customerId),
              inArray(
                askChats.id,
                empty.map((c) => c.id),
              ),
            ),
          );
        await tx
          .update(askPreferences)
          .set({ chatId: null })
          .where(
            and(
              eq(askPreferences.customerId, this.customerId),
              sql`${askPreferences.chatId} is not null and not exists(select 1 from ask_chats c where c.id=${askPreferences.chatId} and c.customer_id=${this.customerId} and c.owner_id=${askPreferences.ownerId})`,
            ),
          );
        await tx
          .delete(askStaffAccess)
          .where(
            and(
              eq(askStaffAccess.customerId, this.customerId),
              sql`${askStaffAccess.createdAt} <= clock_timestamp() - ${this.days} * interval '1 day'`,
            ),
          );
        await tx
          .update(askMaintenance)
          .set({
            lastAttemptAt: sql`clock_timestamp()`,
            lastSuccessAt: sql`clock_timestamp()`,
            deletedRuns: expired.length,
            errorCode: null,
          })
          .where(eq(askMaintenance.customerId, this.customerId));
        return expired.length;
      });
    } catch {
      await this.db
        .insert(askMaintenance)
        .values({
          customerId: this.customerId,
          lastAttemptAt: sql`clock_timestamp()`,
          errorCode: "ASK_RETENTION_FAILED",
        })
        .onConflictDoUpdate({
          target: askMaintenance.customerId,
          set: { lastAttemptAt: sql`clock_timestamp()`, errorCode: "ASK_RETENTION_FAILED" },
        })
        .catch(() => undefined);
      throw new Error("ASK_RETENTION_FAILED");
    }
  }
}
