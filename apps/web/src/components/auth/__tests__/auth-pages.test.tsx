import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PASSWORD_RULE } from "@sr/shared";
import { ChangePasswordCard } from "@/components/account/ChangePasswordCard";
import { emailProblem, newPasswordErrors, passwordProblem } from "../field-checks";
import { NewPasswordFields } from "../form-fields";
import { ForgotForm } from "../forgot-form";
import { InviteDead, InviteForm } from "../invite-form";
import { LOCKED, LoginForm } from "../login-form";
import { ResetDead, ResetDone, ResetForm } from "../reset-form";
import { SetupForm } from "../setup-form";

/**
 * The screens outside the app shell, and the Change password card (MAG-5351).
 * Rendered to markup: what a page shows before anybody types is what these pin.
 */

const html = (el: ReactElement) => renderToStaticMarkup(el);
const noProviders = { google: false, github: false };

const invite = (handoffError?: string, providers = noProviders) =>
  html(
    createElement(InviteForm, {
      token: "tok",
      email: "dana@example.com",
      role: "approver",
      providers,
      handoffError,
    }),
  );

/** Every screen that sets a password, as it first renders. */
const passwordScreens: Array<[string, () => string]> = [
  ["join", () => invite()],
  ["setup", () => html(createElement(SetupForm, { mode: "onprem" }))],
  [
    "reset",
    () =>
      html(createElement(ResetForm, { token: "tok", email: "dana@example.com", managed: true })),
  ],
  ["account", () => html(createElement(ChangePasswordCard))],
];

/** Every form outside the shell, as it first renders. */
const forms: Array<[string, () => string]> = [
  ...passwordScreens.filter(([name]) => name !== "account"),
  ["sign-in", () => html(createElement(LoginForm, { providers: noProviders }))],
  ["forgot password", () => html(createElement(ForgotForm))],
];

describe("the password rule (Text 17)", () => {
  it.each(passwordScreens)("%s states it in the shared words", (_name, render) => {
    expect(render()).toContain(PASSWORD_RULE);
  });
});

describe("no field looks filled when it is empty (Visual 6)", () => {
  it.each([...forms, ["account", () => html(createElement(ChangePasswordCard))] as const])(
    "%s has no dotted placeholder",
    (_name, render) => {
      expect(render()).not.toContain("••");
    },
  );
});

describe("one error style (Visual 14, Text 18)", () => {
  it.each(forms)("%s leaves validation to the app, not the browser", (_name, render) => {
    const markup = render();
    // HTML attribute names are case-insensitive; React writes `noValidate`.
    expect(markup).toMatch(/<form novalidate=""/i);
    // The attributes that make the browser draw its own tooltip.
    expect(markup).not.toMatch(/\srequired=""|\sminlength="|\spattern="/i);
  });

  it("puts an error no field owns as plain text directly above the submit button", () => {
    const markup = invite("invite_failed");
    const alert = markup.indexOf('role="alert"');
    expect(alert).toBeGreaterThan(-1);
    // The next thing after the error is the submit button.
    expect(markup.slice(alert).match(/<\/div>\s*<button/)).not.toBeNull();
    const tag = markup.slice(markup.lastIndexOf("<div", alert), alert + 200);
    expect(tag).toContain("color:var(--err)");
    expect(tag).not.toMatch(/border|background/);
  });

  it("puts a field's error directly under that field", () => {
    const markup = html(
      createElement(NewPasswordFields, {
        password: "short",
        repeat: "shrt",
        onPassword: () => undefined,
        onRepeat: () => undefined,
        errors: { password: "Too short.", repeat: "Those passwords don't match." },
      }),
    );
    expect(markup).toMatch(
      />Password<input[^>]*aria-invalid="true"[^>]*><\/label><div[^>]*role="alert"[^>]*>Too short\.</,
    );
    expect(markup).toMatch(
      />Repeat password<input[^>]*aria-invalid="true"[^>]*><\/label><div[^>]*role="alert"[^>]*>Those passwords don&#x27;t match\.</,
    );
    expect(markup).not.toMatch(/border|background/);
  });

  it("checks the join password's length itself, in the api's words", () => {
    expect(passwordProblem("short")).toBe("Password must be at least 8 characters.");
    expect(passwordProblem("x".repeat(8))).toBeNull();
    expect(passwordProblem("x".repeat(65))).toBe("Password must be at most 64 characters.");
    // Code points, as the api counts: eight emoji are eight characters.
    expect(passwordProblem("🔥".repeat(8))).toBeNull();
  });

  it("says a mismatch as they type, and the length only once they submit", () => {
    expect(newPasswordErrors("short", "", false)).toEqual({});
    expect(newPasswordErrors("short", "sh", false)).toEqual({
      repeat: "Those passwords don't match.",
    });
    expect(newPasswordErrors("short", "short", true)).toEqual({
      password: "Password must be at least 8 characters.",
    });
  });

  it("refuses the addresses the browser's own email check refused", () => {
    expect(emailProblem("")).toBe("Enter your email address.");
    expect(emailProblem("dana")).toBe("Enter a valid email address.");
    expect(emailProblem("dana@example.com")).toBeNull();
  });
});

describe("the Change password card (Visual 12)", () => {
  it("labels every field visibly instead of with a placeholder", () => {
    const markup = html(createElement(ChangePasswordCard));
    for (const label of ["Current password", "New password", "Repeat new password"]) {
      expect(markup).toMatch(new RegExp(`<label[^>]*>${label}<input`));
    }
    expect(markup).not.toContain("placeholder=");
  });
});

describe("the reset page", () => {
  it("says a dead link no longer works, without claiming it expired (Fix 10, Text 9)", () => {
    for (const managed of [true, false]) {
      const markup = html(createElement(ResetDead, { managed }));
      expect(markup).toContain("This link no longer works");
      expect(markup).toContain("It may have been used, replaced or expired.");
      expect(markup).not.toContain("has expired");
      expect(markup).not.toMatch(/[–—]/);
    }
  });

  it("heads the success state 'Password changed' and says no more (Text 10, Text 11)", () => {
    const markup = html(createElement(ResetDone, { email: "dana@example.com" }));
    expect(markup).toContain(">Password changed<");
    expect(markup).not.toContain("Choose a new password");
    expect(markup).not.toContain("recognise");
    expect(markup).not.toContain("That includes");
  });
});

describe("the sign-in page", () => {
  it("says the lockout lasts 15 minutes and points at a reset (Text 24)", () => {
    expect(LOCKED).toBe(
      "Too many failed attempts. Try again in 15 minutes, or reset your password.",
    );
  });

  it("explains a session an admin ended (Fix 5)", () => {
    const notice = "Your session ended. An admin changed your access.";
    expect(html(createElement(LoginForm, { providers: noProviders, notice }))).toContain(notice);
    expect(html(createElement(LoginForm, { providers: noProviders }))).not.toContain(
      "Your session ended",
    );
  });

  it("calls the feature 2FA on the code step", () => {
    const markup = html(
      createElement(LoginForm, {
        providers: noProviders,
        pendingCode: { email: "dana@example.com", provider: "google" },
      }),
    );
    expect(markup).toContain("An administrator can reset your 2FA.");
  });
});

describe("the join page", () => {
  it("has no long dash in what it says", () => {
    for (const reason of ["email_mismatch", "invite_failed"]) {
      expect(invite(reason)).not.toMatch(/[–—]/);
    }
    expect(html(createElement(InviteDead))).not.toMatch(/[–—]/);
  });
});
