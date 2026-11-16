import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { copyText } from "../copy-text";

vi.mock("@/lib/api-client", () => ({
  apiPost: vi.fn(() => new Promise(() => {})),
  ApiError: class ApiError extends Error {},
}));

const { CopyKeyButton, EnrolPanel, ManualKey, keyGroups } = await import("../enrol-panel");

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

describe("the setup screen before the QR arrives", () => {
  const html = renderToStaticMarkup(createElement(EnrolPanel, { onEnrolled: () => {} }));

  it("turns a spinner where the QR goes", () => {
    const slot = html.match(
      /<div role="status" aria-label="Loading the QR code"[^>]*>([\s\S]*?)<\/div>/,
    );
    expect(slot, "no loading QR slot").not.toBeNull();
    expect(slot![1]).toContain('class="gw-spin"');
  });

  it("names the slot only once the QR is there", () => {
    // The e2e suite waits on this label for the painted QR.
    expect(html).not.toContain('aria-label="Authenticator QR code"');
  });

  it("offers no code field before there is a key to take a code from", () => {
    expect(html).not.toContain("Code from the app");
  });
});

describe("the key typed by hand", () => {
  it("is cut into groups of four", () => {
    expect(keyGroups(SECRET)).toEqual([
      "JBSW",
      "Y3DP",
      "EHPK",
      "3PXP",
      "JBSW",
      "Y3DP",
      "EHPK",
      "3PXP",
    ]);
    expect(keyGroups("ABCDEF")).toEqual(["ABCD", "EF"]);
    expect(keyGroups("")).toEqual([]);
  });

  it("breaks a line only between groups", () => {
    const html = renderToStaticMarkup(createElement(ManualKey, { secret: SECRET }));
    expect(html).not.toMatch(/break-all|word-break|overflow-wrap/);
    const groups = [...html.matchAll(/<span style="white-space:nowrap">([A-Z2-7]+)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(groups).toEqual(keyGroups(SECRET));
    // What a person copies off the screen is still the secret.
    expect(html.replace(/<[^>]+>/g, "").replace(/\s+/g, "")).toBe(SECRET);
  });
});

describe("Copy key", () => {
  const label = (state: "idle" | "copied" | "failed") =>
    renderToStaticMarkup(createElement(CopyKeyButton, { state, onCopy: () => {} }));

  it("says Copied, with a tick, once the key is on the clipboard", () => {
    const html = label("copied");
    expect(html).toContain("Copied");
    expect(html).not.toContain("Copy key");
    expect(html).toContain("<polyline");
  });

  it("says so when the browser would not copy", () => {
    const html = label("failed");
    expect(html).toContain("Copy key");
    expect(html).toContain("Could not copy. Select the key and copy it by hand.");
  });

  it("is a plain Copy key otherwise", () => {
    const html = label("idle");
    expect(html).toContain("Copy key");
    expect(html).not.toMatch(/Copied|Could not copy/);
  });
});

describe("copyText", () => {
  it("writes through the Clipboard API where the page has it", async () => {
    const writeText = vi.fn(async () => {});
    const select = vi.fn(() => true);
    expect(await copyText(SECRET, { clipboard: { writeText }, select })).toBe(true);
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(select).not.toHaveBeenCalled();
  });

  it("copies by selection on a page without it (plain http)", async () => {
    const select = vi.fn(() => true);
    expect(await copyText(SECRET, { clipboard: undefined, select })).toBe(true);
    expect(select).toHaveBeenCalledWith(SECRET);
  });

  it("copies by selection when the Clipboard API refuses", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    const select = vi.fn(() => true);
    expect(await copyText(SECRET, { clipboard: { writeText }, select })).toBe(true);
    expect(select).toHaveBeenCalledWith(SECRET);
  });

  it("says it failed when neither works", async () => {
    expect(await copyText(SECRET, { clipboard: undefined, select: () => false })).toBe(false);
  });
});
