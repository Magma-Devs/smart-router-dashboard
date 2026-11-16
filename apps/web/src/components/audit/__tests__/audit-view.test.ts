import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AuditEventRecord } from "@sr/shared";
import { AuditView } from "@/components/audit/AuditView";
import type { AuditFeed } from "@/components/audit/useAuditFeed";

/**
 * The audit table and its Group filter, rendered with a page of rows in hand.
 * The feed is stubbed: these pin what a row says, not how it was read.
 */

const rows = vi.hoisted(() => ({ items: [] as AuditEventRecord[] }));

vi.mock("@/components/audit/useAuditFeed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/audit/useAuditFeed")>();
  return {
    ...actual,
    useAuditFeed: (): AuditFeed => ({
      page: {
        items: rows.items,
        startCursor: "c1",
        endCursor: "c2",
        atNewest: true,
        hasNewer: false,
        hasOlder: false,
        arrived: null,
      },
      items: rows.items,
      loading: false,
      error: null,
      badPosition: false,
      unavailable: false,
      refresh: () => {},
    }),
  };
});

const SESSION_ID = "4f1e9a0c-1b2d-4e3f-8a9b-0c1d2e3f4a5b";

const failedSignIn: AuditEventRecord = {
  id: "e1",
  time: "2026-11-12T12:22:07.000Z",
  action: "signin.failed",
  group: "access",
  source: "dashboard",
  actor: { type: "user", id: null, name: "dana@example.com", email: "dana@example.com" },
  target: null,
  request: null,
  note: "unknown address",
  changes: [],
  context: { ip: "203.0.113.7", client: "Firefox 140 / Linux", session: null },
};

const sessionEnded: AuditEventRecord = {
  ...failedSignIn,
  id: "e2",
  action: "session.revoked",
  actor: { type: "user", id: "u1", name: "Sam Admin", email: "sam@example.com" },
  target: { type: "session", id: SESSION_ID, name: "lee@example.com" },
  request: "req_31",
  note: "password changed",
};

function render(items: AuditEventRecord[]): string {
  rows.items = items;
  return renderToStaticMarkup(createElement(AuditView));
}

/** The table alone, so the filter's options don't count as row text. */
const table = (html: string) => html.slice(html.indexOf("<table"));

describe("the audit table", () => {
  it("names each event in words, keeping its code for the detail sheet", () => {
    const html = table(render([failedSignIn, sessionEnded]));
    expect(html).toContain("Sign-in failed");
    expect(html).toContain("Session ended");
    expect(html).not.toContain("signin.failed");
    expect(html).not.toContain("session.revoked");
  });

  it("shows a target by name, without its id", () => {
    const html = table(render([sessionEnded]));
    expect(html).toContain("lee@example.com");
    expect(html).not.toContain(SESSION_ID);
  });

  it("leaves an approval request's id to the detail sheet", () => {
    expect(table(render([sessionEnded]))).not.toContain("req_31");
  });

  it("names a failed sign-in's address once", () => {
    expect(table(render([failedSignIn])).split("dana@example.com")).toHaveLength(2);
  });

  it("shows an actor's address under a name that is not one", () => {
    expect(table(render([sessionEnded]))).toContain("sam@example.com");
  });

  it("names the group on each row", () => {
    expect(table(render([{ ...failedSignIn, action: "2fa.reset", group: "2fa" }]))).toContain(
      ">2FA</span>",
    );
  });
});

describe("the Group filter", () => {
  const options = () => {
    const html = render([failedSignIn]);
    const select = html.slice(html.indexOf("<select"), html.indexOf("</select>"));
    return [...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [
      m[1],
      m[2],
    ]);
  };

  it("offers the groups something writes, by name", () => {
    expect(options()).toEqual([
      ["", "All groups"],
      ["access", "Access"],
      ["accounts", "Accounts"],
      ["setup", "Setup"],
      ["people", "People"],
      ["2fa", "2FA"],
      ["recovery", "Recovery"],
      ["incidents", "Incidents"],
      ["config", "Configuration"],
    ]);
  });
});

describe("the page's own text", () => {
  /** The page's sentences break with a period or " - ", never a long dash.
   *  The lone dash that stands for "no value" is the app-wide placeholder. */
  it("has no long dash outside comments but the empty-value placeholder", () => {
    const dir = fileURLToPath(new URL("..", import.meta.url));
    for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
      const code = readFileSync(`${dir}/${file}`, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replaceAll(">—<", "><");
      expect(code, file).not.toMatch(/[—–]/);
    }
  });
});
