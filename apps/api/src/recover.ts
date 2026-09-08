import { userInfo } from "node:os";
import { and, eq, sql } from "drizzle-orm";
import { createAuditWriter, createDb, users, type Database, type User } from "@sr/db";
import { createPasswordReset, resetUrl } from "./services/password-reset.js";
import { clearEnrolment, isEnrolled, revokeChallenges } from "./services/two-factor.js";
import { revokeAllForUser } from "./services/sessions.js";
import { config } from "./config.js";

/**
 * Recovery from the host — what you run when nobody can get into the dashboard.
 *
 * ```
 * reset-2fa       --email x@y.com   clear their authenticator
 * reset-password  --email x@y.com   print a one-time set-password link
 * promote-admin   --email x@y.com   when no admin is left at all
 * ```
 *
 * **Shell access on the host is the authorisation.** Someone with root on that
 * machine already controls the deployment — they can read the database, change
 * the image, or replace this file — so these commands hand out nothing new. What
 * they do is make the ordinary recovery paths reachable without inventing a
 * back door in the api, which would be reachable by everyone.
 *
 * **Each command writes a `host.recovery` row**, and that is the point of them
 * being here rather than being a `psql` one-liner in a runbook. A person with a
 * database prompt can already do all of this; what they cannot do is do it
 * *quietly*, once these exist and are the documented path. The row shows up in
 * the customer's own audit log — on managed, marked as performed by Magma.
 *
 * They deliberately reuse the same services the routes use, so a recovery cannot
 * drift into doing something the dashboard would not: `reset-password` prints a
 * link and never sets a password, exactly as an admin's on-prem reset does.
 *
 * See `docs/TWO-FACTOR.md` → "When nobody can get in".
 */

const COMMANDS = ["reset-2fa", "reset-password", "promote-admin"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `Usage: recover <command> --email <address> [--by <name>]

Commands:
  reset-2fa        Clear the account's authenticator. They sign in with their
                   password and set up a new one.
  reset-password   Print a single-use set-password link. It does NOT set a
                   password — the person still chooses their own.
  promote-admin    Make the account an admin. For when no admin is left.

Options:
  --email <address>  The account to act on. Required.
  --by <name>        Who to record as having run this. Defaults to the shell
                     user; see the note about attribution below.

Every command writes a host.recovery row to the audit log naming the command and
the operator, so a recovery is visible in the dashboard afterwards.
`;

/**
 * Who to record as having run this.
 *
 * `SUDO_USER` then the shell user — and **neither is authenticated**. Nothing
 * here proves who is at the keyboard; `--by` is honoured for the same reason,
 * and is not more forgeable than the default. Recording it anyway is right,
 * because the alternative is an anonymous row, and "somebody with root did
 * this at 03:12" is materially more useful than "this happened".
 *
 * What matters is that the row does not *claim* more than it knows, which is
 * why the wording it produces is "reported by", not "performed by". See the
 * note the row itself carries.
 */
function operator(explicit?: string): string {
  const named = explicit?.trim();
  if (named) return named;
  const sudo = process.env.SUDO_USER?.trim();
  if (sudo) return sudo;
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

interface Args {
  command: Command;
  email: string;
  by?: string;
}

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    return { error: command ? `Unknown command: ${command}` : "No command given." };
  }

  let email: string | undefined;
  let by: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--email") {
      email = value;
      i++;
    } else if (flag === "--by") {
      by = value;
      i++;
    } else {
      return { error: `Unknown option: ${flag}` };
    }
  }

  if (!email) return { error: "--email is required." };
  return { command: command as Command, email, by };
}

/**
 * The account to act on, **including suspended and removed ones**.
 *
 * Not `findUserByEmail`, which is scoped to active accounts — that is right for
 * a sign-in and wrong here. Recovery is what you reach for when the state is
 * already wrong, and refusing to look at a suspended row would mean the one
 * command that could fix it cannot see it.
 *
 * Removed accounts are still refused below; the difference is that they are
 * refused with a reason instead of with "no such address", which is the answer
 * that sends an operator hunting for a typo that is not there.
 */
async function findAccount(db: Database, email: string): Promise<User | null> {
  const rows = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .orderBy(sql`case when ${users.status} = 'active' then 0 else 1 end`)
    .limit(1);
  return rows[0] ?? null;
}

export interface RecoveryResult {
  /** Printed to stdout. May carry a single-use link — see `reset-password`. */
  message: string;
  /** What goes in the audit row's note. */
  note: string;
}

export async function runRecovery(
  db: Database,
  args: Args,
  deps: { mode: "managed" | "onprem"; webOrigin?: string } = { mode: config.deploymentMode },
): Promise<RecoveryResult> {
  const user = await findAccount(db, args.email);
  if (!user) throw new Error(`No account for ${args.email}.`);
  if (user.status === "removed") {
    throw new Error(
      `${user.email} was removed from this deployment. Recovery cannot bring an account back — invite the address again, which creates a new one.`,
    );
  }

  const rawOperator = operator(args.by);
  /**
   * On a **managed** deployment the host is ours, so shell access is Magma's by
   * definition — the ticket requires the row to say so, "visible in the
   * customer's log". It is a fact about the deployment, not a claim about the
   * person, which is why it is derived from the mode rather than typed in.
   *
   * On-prem the machine is the customer's and the shell user stands alone.
   */
  const by = deps.mode === "managed" ? `Magma Devs (${rawOperator})` : rawOperator;
  const audit = createAuditWriter(db, {
    onViolation: (v) => console.error("audit:", JSON.stringify(v)),
  });

  let result: RecoveryResult;

  switch (args.command) {
    case "reset-2fa": {
      if (!isEnrolled(user)) {
        throw new Error(`${user.email} has no authenticator set up — nothing to reset.`);
      }
      // The same three writes the admin route makes, for the same three
      // reasons: the secret is destroyed rather than disabled, a challenge in
      // flight against the old secret cannot still be completed, and the
      // sessions end because this is run precisely when nobody is sure who is
      // holding them.
      await clearEnrolment(db, user.id);
      await revokeChallenges(db, user.id);
      await revokeAllForUser(db, user.id, { reason: "admin" });
      result = {
        message: `Cleared the authenticator for ${user.email}. They sign in with their password and set up a new one.`,
        note: `reset-2fa for ${user.email}`,
      };
      break;
    }

    case "reset-password": {
      const origin = deps.webOrigin ?? config.publicWebOrigin;
      if (!origin) {
        throw new Error(
          "PUBLIC_WEB_ORIGIN is not set, so a reset link cannot be built. Set it and run this again.",
        );
      }
      const created = await createPasswordReset(db, { userId: user.id, mode: deps.mode });
      // Printed, never sent. This command does not set a password — the person
      // still chooses their own, which is the same rule the dashboard follows
      // and the reason an admin cannot take an account over silently.
      result = {
        message: [
          `One-time set-password link for ${user.email}:`,
          "",
          `  ${resetUrl(origin, created.rawToken)}`,
          "",
          `Valid until ${created.expiresAt.toISOString()}. It sets a password; it does not sign anyone in.`,
        ].join("\n"),
        note: `reset-password link generated for ${user.email}`,
      };
      break;
    }

    case "promote-admin": {
      if (user.role === "admin" && user.status === "active") {
        throw new Error(`${user.email} is already an active admin.`);
      }
      // Reactivates as well as promotes. The case this exists for is "no admin
      // is left at all", and the commonest way to arrive there is the last
      // admin being suspended — a promotion that left them unable to sign in
      // would fix the role and not the problem.
      await db
        .update(users)
        .set({ role: "admin", status: "active", removedAt: null, removedBy: null })
        .where(and(eq(users.id, user.id)));
      result = {
        message: `${user.email} is now an admin${user.status !== "active" ? " and active again" : ""}.`,
        note: `promote-admin for ${user.email} (was ${user.role}/${user.status})`,
      };
      break;
    }
  }

  await audit.write({
    action: "host.recovery",
    // `host` actors must carry a label — the type makes an anonymous recovery
    // row impossible to write rather than leaving it to be remembered here.
    actor: { kind: "host", label: by },
    target: { type: "member", id: user.id, name: user.email },
    // No ip, no client, no session. `host.recovery` is marked as carrying no
    // access context because there is no browser — the operator's name is the
    // whole of the attribution, and the writer would drop these anyway.
    note: `${result.note} — run on the host, reported by "${by}" (shell access, not an authenticated identity)`,
  });

  return result;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    process.exit(2);
  }

  const url = config.auth.databaseUrl;
  if (!url) {
    console.error("DATABASE_URL is not set. Recovery talks to the accounts database directly.");
    process.exit(2);
  }

  const handle = createDb(url);
  try {
    const result = await runRecovery(handle.db, parsed);
    console.log(result.message);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await handle.sql.end();
  }
}

// Only when run as a program. Importing this module — which the tests do — must
// not open a database connection or call process.exit.
if (process.argv[1] && /(^|[/\\])recover(\.[cm]?[jt]s)?$/.test(process.argv[1])) {
  void main();
}
