import { describe, expect, it } from "vitest";
import { NAV_SECTIONS, visibleNavSections } from "../nav";

/**
 * What the sidebar offers on a deployment with no accounts.
 *
 * `AUTH_MODE=disabled` is the default: no database, no sessions, and none of
 * the account routes registered on the api. An entry that survives into that mode leads to a screen whose data
 * fetch 404s, which reads as a broken dashboard rather than a feature the
 * deployment was never built with.
 */

const hrefs = (authEnabled: boolean) =>
  visibleNavSections(authEnabled).flatMap((s) => s.items.map((i) => i.href));

describe("visibleNavSections", () => {
  it("offers everything when the deployment has accounts", () => {
    expect(visibleNavSections(true)).toEqual(NAV_SECTIONS);
  });

  it("drops Team when it does not", () => {
    expect(hrefs(false)).not.toContain("/team");
  });

  it("keeps the surfaces that have nothing to do with accounts", () => {
    expect(hrefs(false)).toContain("/metrics");
    expect(hrefs(false)).toContain("/upstreams");
    // Account stays: most of it is build provenance, which is what an operator
    // reads off a self-hosted deployment. The page hides its own credential
    // cards instead.
    expect(hrefs(false)).toContain("/account");
  });

  it("leaves no account-only entry anywhere in the tree", () => {
    // The rule rather than today's list, so an entry added later and marked
    // requiresAuth is covered without touching this test.
    for (const section of visibleNavSections(false)) {
      for (const item of section.items) expect(item.requiresAuth).not.toBe(true);
    }
  });
});

describe("the Ask entry", () => {
  it("is in the menu only where this person can use Ask, after the router's own pages", () => {
    expect(hrefs(true)).not.toContain("/ask");
    const first = visibleNavSections(true, null, null, true)[0]!;
    expect(first.items.map((i) => i.href)).toEqual(["/metrics", "/upstreams", "/ask"]);
    expect(NAV_SECTIONS.flatMap((s) => s.items).some((i) => i.href === "/ask")).toBe(false);
  });
});
