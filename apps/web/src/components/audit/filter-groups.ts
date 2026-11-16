import { AUDIT_GROUPS, type AuditGroup } from "@sr/shared";

/**
 * Catalog groups that no shipped code writes: the config-approval flow
 * (MAG-2731) has its events specified but not built. The Group filter and a
 * link's `group=` leave them out, since picking one could only show an empty
 * log. `filter-groups.test.ts` reads the api's writers and fails when this
 * set disagrees with them.
 */
export const UNWRITTEN_GROUPS: ReadonlySet<AuditGroup> = new Set<AuditGroup>(["approval"]);

/** The Group filter's options, in catalog order. */
export const FILTER_GROUPS: readonly AuditGroup[] = AUDIT_GROUPS.filter(
  (group) => !UNWRITTEN_GROUPS.has(group),
);

/** Whether approval events are written, which decides whether a config change
 *  without an approval request says "not required" (see `approvalField`). */
export const APPROVALS_WRITTEN = !UNWRITTEN_GROUPS.has("approval");
