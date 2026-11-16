import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgotForm } from "../forgot-form";
import { InviteDead, InviteForm, InviteSignedIn } from "../invite-form";
import { LoginForm } from "../login-form";
import { ResetDead, ResetDone, ResetForm } from "../reset-form";
import { SetupForm } from "../setup-form";
import { savedTheme } from "../auth-screen";

/**
 * Visual 9: the screens outside the app shell follow the theme the dashboard
 * saved, rather than always drawing dark. A server render runs no effects, so
 * here an effect runs as it is declared; each screen must apply the theme.
 */
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void) => void effect() };
});

const noProviders = { google: false, github: false };
const screens: Array<[string, ReactElement]> = [
  ["sign-in", createElement(LoginForm, { providers: noProviders })],
  ["setup", createElement(SetupForm, { mode: "onprem" })],
  ["forgot password", createElement(ForgotForm)],
  [
    "join",
    createElement(InviteForm, {
      token: "t",
      email: "dana@example.com",
      role: "approver",
      providers: noProviders,
    }),
  ],
  ["join, dead link", createElement(InviteDead)],
  [
    "join, signed in",
    createElement(InviteSignedIn, {
      token: "t",
      invitedEmail: "dana@example.com",
      signedInAs: "sam@example.com",
    }),
  ],
  ["reset", createElement(ResetForm, { token: "t", email: null, managed: true })],
  ["reset, done", createElement(ResetDone, { email: null })],
  ["reset, dead link", createElement(ResetDead, { managed: false })],
];

describe("the auth screens follow the saved theme", () => {
  const setAttribute = vi.fn();
  let stored: string | null;

  beforeEach(() => {
    setAttribute.mockReset();
    stored = "light";
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => (key === "sr:theme" ? stored : null) },
    });
    vi.stubGlobal("document", { documentElement: { setAttribute } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(screens)("%s applies a saved light theme", (_name, screen) => {
    renderToStaticMarkup(screen);
    expect(setAttribute).toHaveBeenCalledWith("data-theme", "light");
  });

  it("leaves the default alone when nothing is saved", () => {
    stored = null;
    renderToStaticMarkup(createElement(LoginForm, { providers: noProviders }));
    expect(setAttribute).not.toHaveBeenCalled();
  });
});

describe("savedTheme", () => {
  it("reads only the two themes the toggle writes", () => {
    expect(savedTheme(() => "light")).toBe("light");
    expect(savedTheme(() => "dark")).toBe("dark");
    expect(savedTheme(() => "sepia")).toBeNull();
    expect(savedTheme(() => null)).toBeNull();
  });

  it("treats storage it may not read as nothing saved", () => {
    expect(
      savedTheme(() => {
        throw new Error("SecurityError");
      }),
    ).toBeNull();
  });
});
