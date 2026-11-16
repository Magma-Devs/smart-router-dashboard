import { isAuditAction, isAuditGroup, type AuditAction, type AuditGroup } from "@sr/shared";

/**
 * What the audit page calls each event and group: the feed, the Group filter
 * and the detail sheet's title read these. The sheet's Action field, the CSV
 * and the API keep the code (`signin.failed`), which is what a filter or a
 * security team's tooling matches on.
 *
 * Keyed by the catalog's own types, so an event or group added to
 * `audit-events.ts` without a name here fails the typecheck.
 */
export const AUDIT_EVENT_LABELS: Record<AuditAction, string> = {
  "signin.succeeded": "Sign-in succeeded",
  "signin.failed": "Sign-in failed",
  "signin.blocked": "Sign-in blocked",
  signout: "Signed out",
  "session.revoked": "Session ended",

  "password.changed": "Password changed",
  "password.reset_requested": "Password reset requested",
  "password.reset_link_generated": "Password reset link created",
  "password.reset_link_revoked": "Password reset link revoked",
  "password.reset_completed": "Password reset completed",
  "password.reset_notice": "Password change email",

  "setup.completed": "Setup completed",

  "member.invited": "Member invited",
  "invite.resent": "Invitation resent",
  "invite.revoked": "Invitation revoked",
  "invite.expired": "Invitation expired",
  "invite.redeemed": "Invitation accepted",
  "member.role_changed": "Role changed",
  "member.removed": "Member removed",

  "2fa.enrolled": "2FA set up",
  "2fa.reset": "2FA reset",
  "2fa.reset_notice": "2FA reset email",

  "host.recovery": "Recovery command run",

  "incident.reported": "Incident reported",

  "provider.added": "Provider added",
  "provider.removed": "Provider removed",
  "provider.renamed": "Provider renamed",
  "provider.edited": "Provider edited",
  "provider.role_changed": "Provider role changed",
  "endpoint.created": "Endpoint created",
  "endpoint.deleted": "Endpoint deleted",
  "endpoint.providers.changed": "Endpoint providers changed",
  "jwt.reissued": "Endpoint token reissued",
  "jwt.revoked": "Endpoint token revoked",
  "apikey.created": "API key created",
  "apikey.deleted": "API key deleted",

  "change.requested": "Change requested",
  "change.approved": "Change approved",
  "change.rejected": "Change rejected",
  "change.self_approved": "Change self-approved",
  "change.cancelled": "Change canceled",
  "change.expired": "Change expired",
  "change.failed": "Change failed",
  "change.probe_override": "Change approved over a failed probe",
};

export const AUDIT_GROUP_LABELS: Record<AuditGroup, string> = {
  access: "Access",
  accounts: "Accounts",
  setup: "Setup",
  people: "People",
  "2fa": "2FA",
  recovery: "Recovery",
  incidents: "Incidents",
  config: "Configuration",
  approval: "Approvals",
};

/** An event's name. A code outside the catalog reads as itself rather than
 *  as nothing: the row still happened. */
export function eventLabel(action: string): string {
  return isAuditAction(action) ? AUDIT_EVENT_LABELS[action] : action;
}

/** A group's name; the writer's `unclassified` fallback reads as itself. */
export function groupLabel(group: string): string {
  return isAuditGroup(group) ? AUDIT_GROUP_LABELS[group] : group;
}
