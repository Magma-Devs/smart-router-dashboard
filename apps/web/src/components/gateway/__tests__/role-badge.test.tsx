import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ROLES, ROLE_LABELS, type Role } from "@sr/shared";
import { roleBadgeLabel } from "../role-badge";

/**
 * The sidebar's role badge says the role the way people say it: "Read-only",
 * not the api's `read_only`, and not shouted in capitals by the stylesheet.
 */

const me = vi.hoisted(() => ({ role: "read_only" as string }));
vi.mock("@/hooks/use-me", () => ({
  useMe: () => ({
    me: { id: "u1", email: "dana@example.com", name: "Dana", avatarUrl: null, role: me.role },
  }),
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

describe("roleBadgeLabel", () => {
  it("names each role by its label", () => {
    expect(roleBadgeLabel("read_only")).toBe("Read-only");
    expect(roleBadgeLabel("requester")).toBe("Requester");
    expect(roleBadgeLabel("approver")).toBe("Approver");
    expect(roleBadgeLabel("admin")).toBe("Admin");
  });

  it("says Local where nobody is signed in", () => {
    expect(roleBadgeLabel(undefined)).toBe("Local");
    expect(roleBadgeLabel(null)).toBe("Local");
  });

  it("shows a role this build does not know as written", () => {
    expect(roleBadgeLabel("auditor")).toBe("auditor");
  });
});

describe("the sidebar's account footer", () => {
  it.each(ROLES.map((r) => [r] as [Role]))("badges %s with its label", async (role) => {
    me.role = role;
    const { SidebarUser } = await import("../Shell");
    const html = renderToStaticMarkup(createElement(SidebarUser));
    expect(html).toContain(`<span class="plan-chip">${ROLE_LABELS[role]}</span>`);
    expect(html).not.toContain(`>${role}<`);
  });
});
