import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_GROUPS, auditGroupOf, type AuditAction } from "@sr/shared";
import { parseAuditLocation } from "@/components/audit/audit-location";
import {
  APPROVALS_WRITTEN,
  FILTER_GROUPS,
  UNWRITTEN_GROUPS,
} from "@/components/audit/filter-groups";

/**
 * Which groups the Group filter offers: the ones something in the product
 * writes. The writers are the api's and the database package's source, read
 * here the way the filter-typing suite reads the api's actor rule.
 */

const dir = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Every non-test `.ts` file under `root`. */
function sources(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("__tests__"))
    .map((f) => readFileSync(join(root, f), "utf8"));
}

/** The events some shipped code writes: a catalog code quoted in its source. */
function writtenActions(): Set<AuditAction> {
  const text = [
    ...sources(dir("../../../../../api/src")),
    ...sources(dir("../../../../../../packages/db/src")),
  ].join("\n");
  return new Set(AUDIT_ACTIONS.filter((action) => text.includes(`"${action}"`)));
}

describe("the Group filter", () => {
  it("leaves out exactly the groups no shipped code writes", () => {
    const written = writtenActions();
    // Guards the scan: were the paths wrong, every group would read as unwritten.
    expect(written.has("signin.failed")).toBe(true);
    const writtenGroups = new Set([...written].map(auditGroupOf));
    const unwritten = AUDIT_GROUPS.filter((g) => !writtenGroups.has(g));
    expect([...UNWRITTEN_GROUPS].sort()).toEqual([...unwritten].sort());
  });

  it("offers the rest in catalog order", () => {
    expect(FILTER_GROUPS).toEqual(AUDIT_GROUPS.filter((g) => !UNWRITTEN_GROUPS.has(g)));
    expect(FILTER_GROUPS).not.toContain("approval");
    // The audit tokens' lifecycle (`apikey.*`) is written into `config`.
    expect(FILTER_GROUPS).toContain("config");
    expect(APPROVALS_WRITTEN).toBe(false);
  });

  it("reads a link's group that it does not offer as no group", () => {
    expect(parseAuditLocation("?group=approval").filters.group).toBe("");
    expect(parseAuditLocation("?group=config").filters.group).toBe("config");
  });
});
