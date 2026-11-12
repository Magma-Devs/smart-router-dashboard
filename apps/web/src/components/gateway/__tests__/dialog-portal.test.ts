/**
 * Every modal surface renders through DialogLayer, portaled to <body>.
 *
 * The Shell wraps each page in `.fade-in`, whose finished entry animation
 * leaves an identity `transform` on it. That makes it the containing block of
 * any `position: fixed` element inside: a backdrop rendered in place covers
 * the page's own box - not the top bar, not the sidebar, and not the viewport
 * below short content.
 *
 * The failure is a dialog drawn in place, and no component exists to test
 * until somebody writes one, so this walks the source instead, as
 * router-scope.test.ts does. There is no DOM in this test runner.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "node_modules" && entry !== "__tests__") walk(p, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(SRC).map((p) => ({ path: relative(SRC, p).split("\\").join("/"), src: readFileSync(p, "utf8") }));
const LAYER = "components/gateway/DialogLayer.tsx";

/** Portals that are not dialogs: a tooltip has no backdrop and takes no focus. */
const NOT_A_DIALOG = new Set(["components/gateway/Tip.tsx"]);

describe("dialogs render through DialogLayer", () => {
  it("finds the source", () => {
    expect(files.some((f) => f.path === LAYER)).toBe(true);
    expect(files.length).toBeGreaterThan(50);
  });

  it("draws no backdrop class in place", () => {
    // DialogLayer takes the class as `backdropClassName`; a `className` that
    // names one is a backdrop rendered wherever its component sits.
    const inPlace = files
      .filter((f) => /className=\{?[^>]*gw-(modal|sheet)-bg/.test(f.src))
      .map((f) => f.path);
    expect(inPlace).toEqual([]);
  });

  it("marks a panel aria-modal only where the layer's behaviour comes with it", () => {
    const bare = files
      .filter((f) => f.path !== LAYER && f.src.includes("aria-modal") && !f.src.includes("useDialogLayer("))
      .map((f) => f.path);
    expect(bare).toEqual([]);
  });

  it("portals to <body> only through the layer", () => {
    const own = files
      .filter((f) => f.path !== LAYER && !NOT_A_DIALOG.has(f.path) && f.src.includes("createPortal("))
      .filter((f) => !f.src.includes("useDialogLayer("))
      .map((f) => f.path);
    expect(own).toEqual([]);
  });

  it("locks the page's scroll only through the layer's counted lock", () => {
    // Two dialogs each saving and restoring `overflow` themselves leave the
    // page locked, or unlocked under an open one, when they close out of order.
    const direct = files.filter((f) => /body\.style\.overflow/.test(f.src)).map((f) => f.path);
    expect(direct).toEqual([]);
  });

  it("is what Modal and SideSheet render", () => {
    for (const path of ["components/gateway/Modal.tsx", "components/gateway/SideSheet.tsx"]) {
      const f = files.find((x) => x.path === path);
      expect(f?.src, path).toContain("<DialogLayer");
    }
  });
});
