/**
 * The audit log's verb set — every event the dashboard can record, in one place.
 *
 * MAG-2770 owns this vocabulary; tasks 1, 3 and 4 emit into it. Four tickets and
 * several authors write these strings, so they live here as a typed catalog
 * rather than as a convention: a typo becomes a typecheck failure instead of a
 * row nobody can filter for. It is also the source `docs/AUDIT.md` is generated
 * from, which is what keeps the published event list from drifting — the ticket
 * requires that list, and both reference APIs (GitHub Enterprise, 1Password)
 * publish one.
 *
 * Mirrors the shape of `constants/metrics.ts`: a ground-truth catalog plus the
 * helpers that read it. See `docs/ACCOUNTS-DESIGN.md` §10 for the writer
 * interface these names travel through.
 */

/**
 * Event groups, in the order the viewer's filter lists them.
 *
 * The split is not cosmetic — it is the retention boundary. Access-flavoured
 * groups are the *security* record and age out sooner; `config` and `approval`
 * are the *compliance* record and are kept long. See MAG-2770 → Retention.
 */
export const AUDIT_GROUPS = [
  "access",
  "accounts",
  "setup",
  "people",
  "2fa",
  "recovery",
  "config",
  "approval",
] as const;

export type AuditGroup = (typeof AUDIT_GROUPS)[number];

/**
 * The group recorded when an event name is not in the catalog.
 *
 * Reserved, and it should never appear: the writer and the catalog ship in the
 * same build, so the only way to reach it is a caller bypassing the types. It
 * exists because losing the row would be worse than filing it oddly — the log's
 * job is to record that something happened, and "we didn't recognise this" is
 * still a truthful thing for it to say. Deliberately **not** a member of
 * `AUDIT_GROUPS`: it is not an option in the viewer's filter and not a row in
 * the published event list.
 */
export const AUDIT_GROUP_FALLBACK = "unclassified";

/** Which ticket emits an event. Provenance for the docs; drives no behaviour. */
export type AuditOrigin = "MAG-2729" | "MAG-2730" | "MAG-2731" | "MAG-2770";

export interface AuditEventSpec {
  readonly group: AuditGroup;
  /**
   * One sentence, written for the customer's security team rather than for us.
   * This is the published definition — it ends up verbatim in `docs/AUDIT.md`.
   */
  readonly description: string;
  /**
   * May the row carry a field-change list?
   *
   * Permissive, not mandatory: `true` means a diff is meaningful for this event,
   * `false` means it must not have one. The ticket's two row shapes — "most
   * events change something and carry a before and after; some are just facts
   * and have nothing to diff" — are exactly this flag.
   */
  readonly carriesChanges: boolean;
  /**
   * May the row carry `ip` / `client` / `session`?
   *
   * **This flag is authoritative.** The database also has a CHECK constraint,
   * but that only enforces the coarse rule the ticket states as a done-when
   * (config and approval events never carry context). The finer question — does
   * a password change carry an IP? — is answered here, where it is visible and
   * reviewable, rather than buried in a constraint. The writer asserts against
   * this; the constraint is a backstop against a direct INSERT.
   */
  readonly carriesAccessContext: boolean;
  readonly origin: AuditOrigin;
}

/**
 * The catalog. Adding an event here is the whole change — the union type, the
 * validators, the group filters and the published docs all derive from it.
 */
export const AUDIT_EVENTS = {
  // ── Access ────────────────────────────────────────────────────────────────
  // Carry ip/client/session. A failed sign-in is worth more to an investigation
  // than a successful one, and it is the row most often missing from a log.
  "signin.succeeded": {
    group: "access",
    description: "A person signed in successfully.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2729",
  },
  "signin.failed": {
    group: "access",
    description:
      "A sign-in attempt was refused. The actor is the matching account when the address is known, and unattributed when it is not.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2729",
  },
  "signin.blocked": {
    group: "access",
    description:
      "A sign-in was refused before the credentials were checked — the account was locked out, suspended or removed.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2729",
  },
  signout: {
    group: "access",
    description: "A person signed out, ending one session.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2729",
  },
  "session.revoked": {
    group: "access",
    description:
      "A session was ended by something other than its holder signing out — revoked from the sessions list, or killed by a password change, a role change or a removal.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2729",
  },

  // ── Accounts ──────────────────────────────────────────────────────────────
  // Carry context: an admin resetting an approver's password and signing in as
  // them is an account takeover using only intended features, and the address it
  // was done from is most of the evidence.
  "password.changed": {
    group: "accounts",
    description: "A person changed their own password.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2729",
  },
  "password.reset_requested": {
    group: "accounts",
    description: "A password reset was requested for an account.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2729",
  },
  "password.reset_link_generated": {
    group: "accounts",
    description:
      "A single-use reset link was generated. The link itself is never recorded — not in the row, not in a log line.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2729",
  },
  "password.reset_completed": {
    group: "accounts",
    description:
      "A reset link was redeemed and a new password set. Every session for that account ended at the same moment.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2729",
  },

  // ── Setup ─────────────────────────────────────────────────────────────────
  "setup.completed": {
    group: "setup",
    description:
      "First run: the deployment's first admin account was created against the installer's setup token.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2729",
  },

  // ── People ────────────────────────────────────────────────────────────────
  // No context. "Dana changed the provider set" is complete without an IP —
  // her name is the answer.
  "member.invited": {
    group: "people",
    description: "An admin invited an email address at a chosen role.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2729",
  },
  "invite.resent": {
    group: "people",
    description: "A pending invitation was sent again, replacing the previous link.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2729",
  },
  "invite.revoked": {
    group: "people",
    description: "A pending invitation was withdrawn before it was redeemed.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2729",
  },
  "invite.expired": {
    group: "people",
    description: "An invitation passed its expiry unredeemed.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2729",
  },
  "invite.redeemed": {
    group: "people",
    description:
      "An invitation was redeemed and the account created. Only the invited address can redeem it.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2729",
  },
  "member.role_changed": {
    group: "people",
    description: "A person's role was changed. Takes effect on their current session, not at next sign-in.",
    carriesChanges: true,
    carriesAccessContext: false,
    origin: "MAG-2729",
  },
  "member.removed": {
    group: "people",
    description:
      "A person was removed. Their sessions ended immediately and their name stays in this log permanently — removal is a state change, not a deletion.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2729",
  },

  // ── Two-factor ────────────────────────────────────────────────────────────
  "2fa.enrolled": {
    group: "2fa",
    description: "A person set up an authenticator app for their own account.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2730",
  },
  "2fa.reset": {
    group: "2fa",
    description:
      "An admin cleared someone's authenticator secret, naming both people. The user sets it up again on their next sign-in.",
    carriesChanges: false,
    carriesAccessContext: true,
    origin: "MAG-2730",
  },

  // ── Recovery ──────────────────────────────────────────────────────────────
  // Run from a shell on the host, so there is no browser, no IP and no session
  // to record — the operator's name is the whole attribution.
  "host.recovery": {
    group: "recovery",
    description:
      "A recovery command was run on the machine hosting the dashboard, naming the command and whoever ran it — including us. Shell access is the authorisation; this row is what stops it being used quietly.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2730",
  },

  // ── Config ────────────────────────────────────────────────────────────────
  // Never carry context — a stated done-when, enforced by the writer and by a
  // CHECK constraint.
  "provider.added": {
    group: "config",
    description: "An upstream provider was added, with its chain, role, interface and capabilities.",
    carriesChanges: true,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "provider.removed": {
    group: "config",
    description: "An upstream provider was removed. Every route using it lost it.",
    carriesChanges: true,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "provider.renamed": {
    group: "config",
    description: "A provider's display name changed. Needs no approval, so it is logged and not gated.",
    carriesChanges: true,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "provider.edited": {
    group: "config",
    description:
      "A provider's connection settings changed — URL, interface, capabilities or auth header. Credentials and URLs record as changed, never as values.",
    carriesChanges: true,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "provider.role_changed": {
    group: "config",
    description: "A provider moved between primary and backup, shifting traffic on or off it.",
    carriesChanges: true,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "endpoint.created": {
    group: "config",
    description: "An endpoint was created and its public URL went live.",
    carriesChanges: true,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "endpoint.deleted": {
    group: "config",
    description: "An endpoint was deleted. Applications still calling it start failing.",
    carriesChanges: true,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "endpoint.providers.changed": {
    group: "config",
    description: "The set of providers backing an endpoint changed.",
    carriesChanges: true,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "jwt.reissued": {
    group: "config",
    description:
      "An endpoint token was reissued. The old token dies the first time the new one is used, or after 24 hours, whichever comes first.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "jwt.revoked": {
    group: "config",
    description:
      "An endpoint token was revoked and every request on it began returning 401. Needs no approval — it is the emergency stop for a leaked credential.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "apikey.created": {
    group: "config",
    description: "An API key was created for a named route. Its value is shown once and never recorded here.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "apikey.deleted": {
    group: "config",
    description: "An API key was deleted. Anything using it stops working.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },

  // ── Approval ──────────────────────────────────────────────────────────────
  "change.requested": {
    group: "approval",
    description: "A configuration change was submitted for approval. There is no draft state — submitting is the act.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "change.approved": {
    group: "approval",
    description: "An approver cleared a change proposed by someone else, and it applied immediately.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "change.rejected": {
    group: "approval",
    description: "An approver turned a change down. The written reason is on the row.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "change.self_approved": {
    group: "approval",
    description:
      "An admin approved their own change, with a written reason. Marked as self-approved everywhere it appears — it never looks like a normal approval.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "change.cancelled": {
    group: "approval",
    description: "A requester withdrew their own change before anyone acted on it.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "change.expired": {
    group: "approval",
    description: "A change sat unanswered for 72 hours and can no longer be approved.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "change.failed": {
    group: "approval",
    description:
      "An approved change did not land. It stays visible and can be retried or cancelled — it is never silently dropped.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
  "change.probe_override": {
    group: "approval",
    description:
      "An admin approved a change whose capability re-probe had failed, with a written reason. Without this, a provider that has gone bad blocks the change that replaces it.",
    carriesChanges: false,
    carriesAccessContext: false,
    origin: "MAG-2731",
  },
} as const satisfies Record<string, AuditEventSpec>;

/** Every event name the log accepts. */
export type AuditAction = keyof typeof AUDIT_EVENTS;

/** The event names of one group, as a narrowed union. */
export type AuditActionOf<G extends AuditGroup> = {
  [K in AuditAction]: (typeof AUDIT_EVENTS)[K]["group"] extends G ? K : never;
}[AuditAction];

/** All event names, in catalog order. */
export const AUDIT_ACTIONS = Object.keys(AUDIT_EVENTS) as AuditAction[];

/** True when `value` is a known event name. */
export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, value);
}

/** True when `value` is a known group. */
export function isAuditGroup(value: unknown): value is AuditGroup {
  return typeof value === "string" && (AUDIT_GROUPS as readonly string[]).includes(value);
}

/** The catalog entry for an event. */
export function auditEventSpec(action: AuditAction): AuditEventSpec {
  return AUDIT_EVENTS[action];
}

/** The group an event belongs to — the value stored in `audit_events.action_group`. */
export function auditGroupOf(action: AuditAction): AuditGroup {
  return AUDIT_EVENTS[action].group;
}

/**
 * May this event carry `ip` / `client` / `session`?
 *
 * The writer drops context from events that must not carry it rather than
 * refusing the write: losing an IP off a row is a smaller failure than losing
 * the row, and the alternative is a 500 on a sign-in because a call site passed
 * one field too many.
 */
export function carriesAccessContext(action: AuditAction): boolean {
  return AUDIT_EVENTS[action].carriesAccessContext;
}

/** May this event carry a field-change list? */
export function carriesChanges(action: AuditAction): boolean {
  return AUDIT_EVENTS[action].carriesChanges;
}

/** Every event in a group, in catalog order. */
export function auditActionsInGroup(group: AuditGroup): AuditAction[] {
  return AUDIT_ACTIONS.filter((a) => AUDIT_EVENTS[a].group === group);
}
