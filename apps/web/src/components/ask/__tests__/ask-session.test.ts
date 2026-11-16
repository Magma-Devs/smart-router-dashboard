import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ signOut: vi.fn(async () => undefined) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubGlobal("window", {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("personal chat requests stay bound to their initiating session", () => {
  it.each(["get", "post", "send"] as const)(
    "never sends a queued %s under a replacement account",
    async (method) => {
      let release!: (response: Response) => void;
      const configuration = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (String(url) === "/api/config") return configuration;
        return Response.json({ ok: true });
      });
      vi.stubGlobal("fetch", fetchImpl);
      const auth = await import("@/lib/auth-store");
      auth.setAuthState({ token: "first-session", user: null });
      auth.markAuthReady();
      const { createAskApi } = await import("../ask-api");
      const api = createAskApi("first-session");
      const path = "/api/ask/chats";
      const pending =
        method === "get"
          ? api.get(path)
          : method === "post"
            ? api.post(path, { question: "first-person-private-question" })
            : api.send("PATCH", "/api/ask/preferences", { chatId: "first-person-chat" });
      const rejected = expect(pending).rejects.toMatchObject({
        statusCode: 409,
        code: "SESSION_CHANGED",
      });
      auth.setAuthState({ token: "replacement-session", user: null });
      release(Response.json({ apiUrl: "https://synthetic-api.invalid", authMode: "enabled" }));
      await rejected;
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(["/api/config"]);
    },
  );
  it("sends a matching current-session request through the normal API client", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json(
          String(url) === "/api/config"
            ? { apiUrl: "https://synthetic-api.invalid", authMode: "enabled" }
            : { id: "synthetic-chat" },
        ),
      );
    vi.stubGlobal("fetch", fetchImpl);
    const auth = await import("@/lib/auth-store");
    auth.setAuthState({ token: "current-session", user: null });
    auth.markAuthReady();
    const { createAskApi } = await import("../ask-api");
    expect(await createAskApi("current-session").post("/api/ask/chats", {})).toEqual({
      id: "synthetic-chat",
    });
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer current-session",
    });
  });
  it("accepts a refreshed bearer for the same person/session but refuses a new session", async () => {
    const token = (sid: string, exp: number) =>
      `e30.${Buffer.from(JSON.stringify({ sub: "same-person", sid, iss: "dashboard", aud: "api", exp })).toString("base64url")}.synthetic-signature`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json(
          String(url) === "/api/config"
            ? { apiUrl: "https://synthetic-api.invalid", authMode: "enabled" }
            : { ok: true },
        ),
      );
    vi.stubGlobal("fetch", fetchImpl);
    const auth = await import("@/lib/auth-store");
    auth.setAuthState({ token: token("same-session", 200), user: null });
    auth.markAuthReady();
    const { createAskApi } = await import("../ask-api");
    expect(await createAskApi(token("same-session", 100)).get("/api/ask/chats")).toEqual({
      ok: true,
    });
    await expect(
      createAskApi(token("other-session", 100)).get("/api/ask/chats"),
    ).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one config read, one matching API request
  });

  it.each([
    [true, undefined],
    [false, undefined],
    [true, "admin"],
    [false, "admin"],
  ] as const)(
    "a late failed request ends only its own current session (account changed: %s, ended by: %s)",
    async (changed, endedBy) => {
      let release!: (response: Response) => void;
      const reply = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url) =>
          String(url) === "/api/config"
            ? Response.json({ apiUrl: "https://synthetic-api.invalid", authMode: "enabled" })
            : reply,
        );
      vi.stubGlobal("fetch", fetchImpl);
      const auth = await import("@/lib/auth-store");
      auth.setAuthState({ token: "first-session", user: null });
      auth.markAuthReady();
      const { createAskApi } = await import("../ask-api");
      const request = createAskApi("first-session").get("/api/ask/chats");
      const rejected = expect(request).rejects.toMatchObject({
        statusCode: 401,
        code: "SESSION_INVALID",
      });
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      if (changed) auth.setAuthState({ token: "replacement-session", user: null });
      release(
        Response.json(
          { code: "SESSION_INVALID", message: "Session ended", endedBy },
          { status: 401 },
        ),
      );
      await rejected;
      const { signOut } = await import("next-auth/react");
      if (changed) {
        await Promise.resolve();
        await Promise.resolve();
        expect(signOut).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(signOut).toHaveBeenCalledOnce());
        expect(signOut).toHaveBeenCalledWith({
          redirectTo: endedBy === "admin" ? "/login?reason=access_changed" : "/login",
        });
      }
    },
  );
});
