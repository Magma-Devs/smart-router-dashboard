import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askSubmitSchema } from "@sr/shared";

let exitCode: typeof process.exitCode;
beforeEach(() => {
  vi.resetModules();
  exitCode = process.exitCode;
  vi.stubEnv("ASK_DATA_SMOKE", "true");
  vi.stubEnv("ASK_DATA_SMOKE_API_URL", "http://127.0.0.1:12345");
  vi.stubEnv("ASK_DATA_SMOKE_SESSION_TOKEN", "synthetic-session-secret");
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("metered operator smoke", () => {
  it("uses only normal session-authenticated API admission/polling and prints no answer values", async () => {
    const answer = {
      contractVersion: 1,
      summary: "private-synthetic-answer",
      sections: [{ title: "Fixture", body: "private-synthetic-metric" }],
      answeredAt: new Date().toISOString(),
      evidence: [],
    };
    const replies = [
      { acceptingQuestions: true },
      { id: "chat-fixture" },
      { id: "run-fixture" },
      { id: "run-fixture", status: "succeeded", answer },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(replies.shift()));
    vi.stubGlobal("fetch", fetchImpl);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await import("../ask-smoke.js");
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/ask/capabilities",
      "/api/ask/chats",
      "/api/ask/chats/chat-fixture/runs",
      "/api/ask/runs/run-fixture",
    ]);
    // The question it submits is one the API admits.
    expect(askSubmitSchema.safeParse(JSON.parse(String(fetchImpl.mock.calls[2]![1]!.body))).success).toBe(
      true,
    );
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(new URL(String(url)).hostname).toBe("127.0.0.1");
      expect(init!.headers).toMatchObject({ authorization: "Bearer synthetic-session-secret" });
    }
    const output = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain('"answerValidated":true');
    expect(output).not.toContain("private-synthetic");
    expect(output).not.toContain("synthetic-session-secret");
  });
  it("cannot invoke a provider when normal API admission is unavailable", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ acceptingQuestions: false }));
    vi.stubGlobal("fetch", fetchImpl);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("../ask-smoke.js");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.map(([value]) => String(value)).join("")).toContain(
      '"code":"SMOKE_FAILED"',
    );
  });
  it("rejects credential-bearing destinations before any HTTP request", async () => {
    vi.stubEnv("ASK_DATA_SMOKE_API_URL", "https://user:password@example.test/?token=secret");
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("../ask-smoke.js");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([value]) => String(value)).join("")).not.toContain("password");
  });
});
