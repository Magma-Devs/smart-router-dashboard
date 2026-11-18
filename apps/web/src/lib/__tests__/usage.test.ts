import { describe, expect, it } from "vitest";
import { askAnswerProps, pageOf, profileOf, searchKind, tabOf, type UsageViewer } from "../usage";

describe("usage data's page, tab and look-up kind", () => {
  it("names the page and the tab", () => {
    expect(pageOf("/metrics")).toBe("metrics");
    expect(pageOf("/upstreams")).toBe("upstreams");
    expect(pageOf("/standalone")).toBe("standalone");
    expect(pageOf("/ask")).toBe("ask");
    expect(pageOf("/login")).toBe("other");
    expect(tabOf("/metrics", "?tab=errors")).toBe("errors");
    expect(tabOf("/metrics", "")).toBe("metrics");
    expect(tabOf("/team", "?tab=errors")).toBe("none");
  });

  it("says what kind of value was looked up, never the value", () => {
    const now = 1_792_323_767;
    const minted = ((BigInt(now - 60) << 32n) | 7n).toString();
    expect(searchKind(minted, now)).toBe("request-id");
    expect(searchKind("15972212763463815960", now)).toBe("old-request-id");
    expect(searchKind("0x" + "ab".repeat(32), now)).toBe("hash");
    expect(searchKind("my-order-42", now)).toBe("other");
  });
});

describe("the viewer's profile", () => {
  const viewer: UsageViewer = { id: "6f1e0c2a9b8d7e6f5a4b3c2d1e0f9a8b", staff: false, role: "approver", created: "2026-03", twoFactor: false, signIn: "google" };

  it("names a customer by tenant, role and id prefix, never an address", () => {
    expect(profileOf({ tenant: "tenant-a", viewer })).toEqual({
      $name: "tenant-a · approver · 6f1e0c2a",
      $created: "2026-03-01T00:00:00",
      tenant: "tenant-a",
      staff: false,
      role: "approver",
      two_factor: false,
      sign_in: "google",
    });
    // An address on a customer's answer is not used, whatever the api sent.
    const leaked = profileOf({ tenant: "tenant-a", viewer: { ...viewer, email: "ops@client.example" } });
    expect(JSON.stringify(leaked)).not.toContain("client.example");
  });

  it("names a staff member by their address", () => {
    expect(profileOf({ tenant: "tenant-a", viewer: { ...viewer, staff: true, email: "someone@magmadevs.com" } }))
      .toMatchObject({ $name: "someone@magmadevs.com", $email: "someone@magmadevs.com", staff: true });
  });

  it("leaves out what the api did not know", () => {
    const out = profileOf({ tenant: "t", viewer: { id: viewer.id, staff: false, role: "admin" } as UsageViewer });
    expect(out).toEqual({ $name: "t · admin · 6f1e0c2a", tenant: "t", staff: false, role: "admin" });
    expect(profileOf({ tenant: "t", viewer: { ...viewer, created: "2026-03-14" } })).not.toHaveProperty("$created");
  });
});

describe("how an Ask run ended", () => {
  const run = { createdAt: "2026-11-18T10:00:00.000Z", completedAt: "2026-11-18T10:00:12.340Z", error: null, answer: null };

  it("is the status, the seconds and the answer's size", () => {
    const answer = { summary: "s", sections: [{ title: "t", body: "b" }, { title: "u", body: "c" }], contractVersion: 1, answeredAt: run.completedAt, evidence: [] };
    expect(askAnswerProps({ ...run, status: "succeeded", answer } as Parameters<typeof askAnswerProps>[0]))
      .toEqual({ result: "succeeded", seconds: 12.34, sections: 2, evidence: 0 });
  });

  it("names the error code the catalog lists, any other as other", () => {
    expect(askAnswerProps({ ...run, status: "failed", error: { code: "ASK_TIMEOUT", message: "m" } })).toMatchObject({ result: "failed", error: "ASK_TIMEOUT" });
    expect(askAnswerProps({ ...run, status: "failed", error: { code: "ASK_NOT_FOUND", message: "m" } })).toMatchObject({ error: "other" });
  });

  it("is nothing for a run that has not ended", () => {
    for (const status of ["queued", "running", "cancelling"] as const) expect(askAnswerProps({ ...run, status, completedAt: null })).toBeNull();
  });
});
