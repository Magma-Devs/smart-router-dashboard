import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectedAccounts } from "@/app/(app)/account/connected-accounts";
import {
  AboutDeployment,
  deploymentFacts,
  type VersionInfo,
} from "@/app/(app)/account/about-deployment";

/** Rendered text with the markup taken out, one space between words. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("Connected accounts", () => {
  const both = { google: true, github: true };
  const render = (props: Parameters<typeof ConnectedAccounts>[0]) =>
    renderToStaticMarkup(createElement(ConnectedAccounts, props));

  it("says, for each provider the deployment offers, whether this account is linked", () => {
    const out = text(
      render({ offered: both, linked: { google: true, github: false }, email: "dana@example.com" }),
    );
    expect(out).toContain("Google Linked");
    expect(out).toContain("GitHub Not linked");
  });

  it("lists only the providers the deployment offers", () => {
    const out = text(
      render({
        offered: { google: true, github: false },
        linked: { google: false, github: true },
        email: "d@example.com",
      }),
    );
    expect(out).toContain("Google Not linked");
    expect(out).not.toContain("GitHub");
  });

  it("is absent where the deployment offers no provider", () => {
    expect(
      render({ offered: { google: false, github: false }, linked: both, email: "d@example.com" }),
    ).toBe("");
  });

  it("says how to link one, with the address it has to match, only while one is not linked", () => {
    const some = text(
      render({ offered: both, linked: { google: true, github: false }, email: "dana@example.com" }),
    );
    expect(some).toContain("To link one, sign in with it once.");
    expect(some).toContain("dana@example.com (on GitHub, your primary address).");
    expect(text(render({ offered: both, linked: both, email: "dana@example.com" }))).not.toContain(
      "To link one",
    );
  });

  it("claims nothing about a link before the account has been read", () => {
    const out = text(render({ offered: both, linked: undefined, email: undefined }));
    expect(out).toContain("Google");
    expect(out).not.toMatch(/Linked|Not linked|To link one/);
  });
});

describe("About this deployment", () => {
  const v = (over: Partial<VersionInfo> = {}): VersionInfo => ({
    commit: "5a28e44c0ffee",
    version: "0.68.0",
    env: "production",
    startedAt: "2026-11-16T08:00:00.000Z",
    uptimeSec: 3 * 3600 + 120,
    ...over,
  });
  const labels = (info: VersionInfo) => deploymentFacts(info).map((f) => f.label);

  it("shows the version, the commit, when it started and how long it has run", () => {
    expect(labels(v())).toEqual(["Version", "Commit", "Started", "Uptime"]);
    const facts = deploymentFacts(v());
    expect(facts.find((f) => f.label === "Commit")?.value).toBe("5a28e44c0ffe");
    expect(facts.find((f) => f.label === "Uptime")?.value).toBe("3h 2m");
  });

  it("has no Commit row for a build that recorded none", () => {
    expect(labels(v({ commit: "unknown" }))).not.toContain("Commit");
    expect(labels(v({ commit: "dev" }))).not.toContain("Commit");
    expect(labels(v({ commit: "" }))).not.toContain("Commit");
  });

  it("has no Version row for a build without APP_VERSION", () => {
    expect(labels(v({ version: "0.0.0" }))).not.toContain("Version");
  });

  it("names the runtime mode only when it is not production", () => {
    expect(labels(v())).not.toContain("Runtime mode");
    const dev = deploymentFacts(v({ env: "development" }));
    expect(dev.find((f) => f.label === "Runtime mode")?.value).toBe("development");
  });

  it("prints no placeholder for what it does not know", () => {
    const html = text(
      renderToStaticMarkup(
        createElement(AboutDeployment, { version: v({ commit: "unknown" }), error: false }),
      ),
    );
    expect(html).toContain("About this deployment");
    expect(html).not.toMatch(/unknown|production|Environment|—/);
  });
});
