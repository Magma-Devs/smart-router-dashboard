import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ROLES, ROLE_COLORS, type Role } from "@sr/shared";
import { InviteStateChip, RoleBadge, roleChipStyle } from "../bits";
import { DeploymentModeProvider, type DeploymentMode } from "../deployment-mode";
import { InviteModal } from "../InviteModal";
import { ResetLinkModal } from "../ResetLinkModal";
import { ResetTwoFactorModal } from "../ResetTwoFactorModal";
import { InviteForm } from "@/components/auth/invite-form";

// The dialogs portal to <body>, which a server render has not got: draw them
// inline so their words can be read.
vi.mock("@/components/gateway/Modal", () => ({
  Modal: ({
    open,
    title,
    children,
    footer,
  }: {
    open: boolean;
    title: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
  }) =>
    open ? createElement("div", null, createElement("h2", null, title), children, footer) : null,
}));
vi.mock("next-auth/react", () => ({ signIn: vi.fn(), signOut: vi.fn() }));

const html = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);
const inMode = (mode: DeploymentMode, node: ReturnType<typeof createElement>) =>
  html(createElement(DeploymentModeProvider, { mode, children: node }));
const member = {
  id: "m1",
  name: "Kito Alvarez",
  email: "kito@example.com",
  role: "approver" as Role,
};

describe("role colours", () => {
  it("draws every role in its own colour from ROLE_COLORS", () => {
    const styles = ROLES.map((r) => roleChipStyle(r));
    for (const [i, s] of styles.entries()) {
      expect(String(s.color), ROLES[i]).toContain(ROLE_COLORS[ROLES[i]!]);
      expect(String(s.background), ROLES[i]).toContain(ROLE_COLORS[ROLES[i]!]);
    }
    expect(new Set(styles.map((s) => s.color)).size).toBe(ROLES.length);
  });

  it("uses neither the error, the brand nor the info tag for a role", () => {
    for (const role of ROLES) {
      const chip = html(createElement(RoleBadge, { role }));
      expect(chip, role).not.toMatch(/gw-tag--(brand|err|bad|info)/);
      expect(chip, role).toContain(ROLE_COLORS[role]);
    }
  });

  it("draws the join page's role chip exactly as the Team page does", () => {
    for (const role of ROLES) {
      const page = html(
        createElement(InviteForm, {
          token: "t",
          email: "new@example.com",
          role,
          providers: { google: false, github: false },
        }),
      );
      expect(page, role).toContain(html(createElement(RoleBadge, { role })));
      expect(page, role).not.toContain("gw-tag--info");
    }
  });

  it("describes requester and approver without promising approvals, on the join page too", () => {
    const page = html(
      createElement(InviteForm, {
        token: "t",
        email: "new@example.com",
        role: "approver",
        providers: { google: false, github: false },
      }),
    );
    expect(page).toContain("Same access as Read-only for now.");
  });
});

describe("invitation state chips", () => {
  it("are capitalised and drawn in no role's colour", () => {
    for (const [state, label] of [
      ["pending", "Pending"],
      ["expired", "Expired"],
      ["revoked", "Revoked"],
    ] as const) {
      const chip = html(createElement(InviteStateChip, { state }));
      expect(chip).toContain(label);
      for (const role of ROLES)
        expect(chip, `${state} vs ${role}`).not.toContain(ROLE_COLORS[role]);
      expect(chip).not.toContain("gw-tag--info");
    }
  });
});

describe("the invite dialog", () => {
  const dialog = () =>
    createElement(InviteModal, { open: true, onClose: () => {}, onInvited: () => {} });

  it("says on managed that the link is emailed", () => {
    const text = inMode("managed", dialog());
    expect(text).toContain("We email them a link. The account is created with this address.");
    expect(text).not.toContain("Whoever holds the link");
  });

  it("warns on-prem that whoever holds the link can accept it", () => {
    expect(inMode("onprem", dialog())).toContain("Whoever holds the link can accept it");
  });

  it("shows each role as its chip and promises no approvals", () => {
    const text = inMode("managed", dialog());
    for (const role of ROLES)
      expect(text, role).toContain(html(createElement(RoleBadge, { role })));
    // "Approver" is the role's name; what may not appear is a promise to approve.
    expect(text).not.toMatch(/\bapprove\b|approval|propos/i);
  });
});

describe("the reset-link dialog", () => {
  const dialog = () => createElement(ResetLinkModal, { open: true, onClose: () => {}, member });

  it("says the link is never emailed, true in both modes", () => {
    for (const mode of ["managed", "onprem"] as const) {
      const text = inMode(mode, dialog());
      expect(text, mode).toContain("This link is never emailed. You hand it over yourself.");
      expect(text, mode).not.toContain("Nothing is emailed");
    }
  });

  it("points to the emailed reset on managed only", () => {
    expect(inMode("managed", dialog())).toContain("Forgot your password?");
    expect(inMode("onprem", dialog())).not.toContain("Forgot your password?");
  });
});

describe("the reset-2FA dialog", () => {
  it("names the feature 2FA", () => {
    const text = html(
      createElement(ResetTwoFactorModal, {
        open: true,
        onClose: () => {},
        member,
        onReset: () => {},
      }),
    );
    expect(text).toContain("Reset 2FA");
    expect(text).not.toMatch(/two-factor/i);
  });
});
