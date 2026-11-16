import { ROLE_LABELS, isRole } from "@sr/shared";

/**
 * The word on the sidebar's badge: the role's label ("Read-only"), or "Local"
 * where nobody is signed in. A role this build does not know is shown as the
 * api wrote it rather than hidden.
 */
export function roleBadgeLabel(role: string | null | undefined): string {
  if (!role) return "Local";
  return isRole(role) ? ROLE_LABELS[role] : role;
}
