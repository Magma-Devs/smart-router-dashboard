import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  checkPasswordBreached,
  validatePassword,
  validatePasswordShape,
} from "../services/password.js";

const savedEnv: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Derived, not hardcoded — the point is the split the range API makes, and a
 *  transcribed constant only tests my typing. */
const HUNTER = "hunter2hunter2";
const HUNTER_SHA1 = createHash("sha1").update(HUNTER, "utf8").digest("hex").toUpperCase();
const PREFIX = HUNTER_SHA1.slice(0, 5);
const SUFFIX = HUNTER_SHA1.slice(5);

/** Stub the range endpoint with a body in HIBP's `SUFFIX:COUNT` format. */
function stubHibp(body: string, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn(
    async () => new Response(body, { status: init.status ?? (init.ok === false ? 500 : 200) }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("validatePasswordShape", () => {
  it("accepts an ordinary passphrase", () => {
    expect(validatePasswordShape("correct horse battery staple")).toBeNull();
  });

  it("enforces the length bounds and nothing else", () => {
    expect(validatePasswordShape("x".repeat(PASSWORD_MIN_LENGTH - 1))?.code).toBe("too_short");
    expect(validatePasswordShape("x".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(validatePasswordShape("x".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(validatePasswordShape("x".repeat(PASSWORD_MAX_LENGTH + 1))?.code).toBe("too_long");
  });

  it("imposes no composition rules", () => {
    // NIST 800-63B, and the ticket: no "must contain a symbol". Spaces and
    // all-lowercase are fine.
    for (const value of [
      "        a",
      "aaaaaaaaaaaa",
      "a b c d e f",
      "パスワードをここに入力してください",
    ]) {
      expect(validatePasswordShape(value), value).toBeNull();
    }
  });

  it("refuses a password that bcrypt would silently truncate", () => {
    // 64 emoji is 64 characters and 256 bytes. bcrypt stops at 72 bytes without
    // saying so, which would make the tail of someone's password decorative.
    const problem = validatePasswordShape("🔥".repeat(PASSWORD_MAX_LENGTH));
    expect(problem?.code).toBe("too_many_bytes");
  });
});

describe("checkPasswordBreached", () => {
  it("sends only the first five hash characters — never the password", async () => {
    const fetchMock = stubHibp(`${SUFFIX}:42\n`);
    const result = await checkPasswordBreached(HUNTER);

    expect(result).toEqual({ breached: true, indeterminate: false });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${PREFIX}`);
    expect(url).not.toContain(HUNTER);
    expect(url).not.toContain(SUFFIX);
  });

  it("asks for padding, so response size leaks nothing about the prefix", async () => {
    const fetchMock = stubHibp("0000000000000000000000000000000000000:0\n");
    await checkPasswordBreached(HUNTER);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)["Add-Padding"]).toBe("true");
  });

  it("ignores padded decoy entries, which come back with a zero count", async () => {
    // Our own suffix, but with count 0 — that is padding, not a breach.
    stubHibp(`${SUFFIX}:0\n`);
    expect(await checkPasswordBreached(HUNTER)).toEqual({
      breached: false,
      indeterminate: false,
    });
  });

  it("reports a clean password as clean", async () => {
    stubHibp("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:5\n");
    expect(await checkPasswordBreached(HUNTER)).toEqual({ breached: false, indeterminate: false });
  });

  it("fails open when HIBP is unreachable, and says the answer was unknown", async () => {
    // On-prem may have no egress at all. Failing closed here would make the
    // first admin account uncreatable — locking an operator out of their own
    // install to enforce a defence-in-depth check.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    );
    const result = await checkPasswordBreached(HUNTER);
    expect(result.breached).toBe(false);
    expect(result.indeterminate).toBe(true);
  });

  it("fails open on a non-200 too", async () => {
    stubHibp("nope", { status: 503 });
    const result = await checkPasswordBreached(HUNTER);
    expect(result).toMatchObject({ breached: false, indeterminate: true, reason: "status_503" });
  });

  it("makes no request at all when explicitly disabled", async () => {
    // The honest thing for an air-gapped site: turn it off deliberately rather
    // than relying on a silent timeout every sign-up.
    const fetchMock = stubHibp("");
    setEnv({ PASSWORD_BREACH_CHECK: "off" });
    const result = await checkPasswordBreached(HUNTER);
    expect(result).toMatchObject({ breached: false, indeterminate: true, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("validatePassword", () => {
  it("checks shape before spending a network round-trip", async () => {
    const fetchMock = stubHibp("");
    const problem = await validatePassword("short");
    expect(problem?.code).toBe("too_short");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a breached password with a message a person can act on", async () => {
    stubHibp(`${SUFFIX}:1234\n`);
    const problem = await validatePassword(HUNTER);
    expect(problem?.code).toBe("breached");
    expect(problem?.message).toMatch(/data breach/i);
  });

  it("lets a good password through", async () => {
    stubHibp("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n");
    expect(await validatePassword("correct horse battery staple")).toBeNull();
  });
});
