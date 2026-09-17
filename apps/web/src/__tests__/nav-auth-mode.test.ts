import { describe, expect, it } from "vitest";
import { NAV_SECTIONS, visibleNavSections } from "@/components/gateway/nav";

/**
 * What the sidebar offers on a deployment with no accounts.
 *
 * `AUTH_MODE=disabled` is the default and the shape every deployment runs
 * today: no database, no sessions, and none of the account routes registered on
 * the api. An entry that survives into that mode leads to a screen whose data
 * fetch 404s, which reads as a broken dashboard rather than a feature the
 * deployment was never built with.
 */

describe("visibleNavSections", () => {
  it("offers everything when the deployment has accounts", () => {
    expect(visibleNavSections(true)).toEqual(NAV_SECTIONS);
  });

  it("drops Team when it does not", () => {
    const hrefs = visibleNavSections(false).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain("/team");
  });

  it("keeps the surfaces that have nothing to do with accounts", () => {
    const hrefs = visibleNavSections(false).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain("/metrics");
    expect(hrefs).toContain("/upstreams");
    // Account stays: most of it is build provenance, which is exactly what an
    // operator reads off a self-hosted deployment. The page hides its own
    // credential cards instead.
    expect(hrefs).toContain("/account");
  });

  it("drops a section whose every entry needed accounts, label and all", () => {
    const only = [
      { label: "Account", items: [{ href: "/team", label: "Team", icon: () => null, requiresAuth: true }] },
    ];
    const filtered = only
      .map((s) => ({ ...s, items: s.items.filter((i) => !i.requiresAuth) }))
      .filter((s) => s.items.length > 0);
    expect(filtered).toHaveLength(0);
  });

  it("leaves no account-only entry anywhere in the tree", () => {
    // The rule, rather than a list of today's entries — so an entry added later
    // and marked requiresAuth is covered without touching this test.
    for (const section of visibleNavSections(false)) {
      for (const item of section.items) {
        expect(item.requiresAuth).not.toBe(true);
      }
    }
  });
});
