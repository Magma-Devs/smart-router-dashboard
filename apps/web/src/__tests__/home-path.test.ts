import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { HOME_PATH } from "@/lib/home-path";

/**
 * Where people are sent after signing in, and every other redirect the web
 * makes, must name a page that exists.
 *
 * A page taken out of the sidebar is still where people land while any
 * redirect names it. These checks keep `/overview` gone — no route of that
 * name, and nothing in the source naming it — and, more generally, keep every
 * redirect, link and sign-in target pointed at a page the app has.
 */

const SRC = fileURLToPath(new URL("../", import.meta.url));
const APP = join(SRC, "app");
const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));

// ── the app's routes, from the file tree ────────────────────────────────────

/** A route as matchable segments: a literal, `*` for one dynamic segment, `**`
 *  for a catch-all. Route groups (`(app)`) contribute no segment. */
function routes(dir = APP, prefix: string[] = [], out: string[][] = []): string[][] {
  const entries = readdirSync(dir);
  if (entries.includes("page.tsx") || entries.includes("route.ts")) out.push(prefix);
  for (const entry of entries) {
    const p = join(dir, entry);
    if (!statSync(p).isDirectory() || entry === "__tests__") continue;
    const segment = /^\(.*\)$/.test(entry)
      ? null
      : /^\[\[?\.\.\./.test(entry)
        ? "**"
        : /^\[.*\]$/.test(entry)
          ? "*"
          : entry;
    routes(p, segment === null ? prefix : [...prefix, segment], out);
  }
  return out;
}

const ROUTES = routes();

function isRoute(path: string): boolean {
  const parts = path.split(/[?#]/)[0]!.split("/").filter(Boolean);
  return ROUTES.some((route) => {
    for (let i = 0; i < route.length; i++) {
      if (route[i] === "**") return parts.length > i;
      if (i >= parts.length) return false;
      if (route[i] !== "*" && route[i] !== parts[i]) return false;
    }
    return route.length === parts.length;
  });
}

/** A target the browser can open: a page, a route handler, or a public file. */
function exists(path: string): boolean {
  const bare = path.split(/[?#]/)[0]!;
  return isRoute(bare) || (/\.[a-z0-9]+$/i.test(bare) && existsSync(join(PUBLIC, bare)));
}

// ── every navigation target written in the source ───────────────────────────

function sources(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "__tests__" && entry !== "node_modules") sources(p, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/** The calls and props that send the browser somewhere. */
const NAVIGATES =
  /\bredirect\(|Response\.redirect\(|location\.href\s*=|router\.(?:push|replace)\(|\bredirectTo:|\bcallbackUrl:|\bhref[=:]/;

/** Same-origin path literals on a line: "…", '…' or `…${x}…` (an
 *  interpolation stands for one segment). */
const PATH_LITERAL = /(["'`])(\/(?!\/)(?:[^"'`\\$]|\$\{[^}]*\})*)\1/g;

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

interface Target {
  file: string;
  line: number;
  path: string;
}

function navigationTargets(): Target[] {
  const found: Target[] = [];
  for (const file of sources()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (isComment(text) || !NAVIGATES.test(text)) return;
      for (const m of text.matchAll(PATH_LITERAL)) {
        found.push({
          file: relative(SRC, file).split(sep).join("/"),
          line: i + 1,
          path: m[2]!.replace(/\$\{[^}]*\}/g, "x"),
        });
      }
    });
  }
  return found;
}

// next-auth's runtime needs Next's server modules, which vitest cannot load.
vi.mock("next-auth", () => ({ CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: (o: object) => ({ id: "google", ...o }) }));
vi.mock("next-auth/providers/github", () => ({ default: (o: object) => ({ id: "github", ...o }) }));
vi.mock("next-auth/providers/credentials", () => ({ default: (o: object) => ({ id: "credentials", ...o }) }));

type Authorized = (params: {
  auth: { user?: object } | null;
  request: { nextUrl: URL };
}) => boolean | Response;

describe("where the dashboard opens", () => {
  it("is /metrics, and that page exists", () => {
    expect(HOME_PATH).toBe("/metrics");
    expect(isRoute(HOME_PATH)).toBe(true);
  });

  it("is where a signed-in visit to /login or /setup is sent", async () => {
    const { authConfig } = await import("../auth.config");
    const authorized = authConfig.callbacks.authorized as unknown as Authorized;
    for (const path of ["/login", "/setup"]) {
      const res = authorized({
        auth: { user: { id: "user-1" } },
        request: { nextUrl: new URL(`http://dash.example.com${path}`) },
      });
      expect(res, path).toBeInstanceOf(Response);
      expect(new URL((res as Response).headers.get("location")!).pathname, path).toBe(HOME_PATH);
    }
  });
});

describe("/overview", () => {
  it("is not a route", () => {
    expect(isRoute("/overview")).toBe(false);
    expect(ROUTES.some((route) => route.includes("overview"))).toBe(false);
  });

  it("is not named anywhere in the web's source, outside the api's own path", () => {
    const named = sources().flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((text, i) => ({ text, at: `${relative(SRC, file)}:${i + 1}` }))
        .filter(({ text }) => /(?<!\/api\/metrics)\/overview\b/.test(text))
        .map(({ at }) => at),
    );
    expect(named).toEqual([]);
  });
});

describe("every redirect, link and sign-in target", () => {
  const targets = navigationTargets();

  it("is found — the scan reads the calls it is meant to", () => {
    // The sign-out paths and the account pages' links are literals today; if
    // none were found, the patterns above have stopped matching anything.
    expect(targets.map((t) => t.path)).toEqual(
      expect.arrayContaining(["/login", "/invite/x", "/account/two-factor", "/forgot-password"]),
    );
  });

  it("names a page the app has", () => {
    const missing = targets
      .filter((t) => !exists(t.path))
      .map((t) => `${t.file}:${t.line} → ${t.path}`);
    expect(missing).toEqual([]);
  });
});
