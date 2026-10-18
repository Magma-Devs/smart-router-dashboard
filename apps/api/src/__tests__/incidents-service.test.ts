import { describe, expect, it } from "vitest";
import { readIncidentSettings } from "../config.js";
import {
  buildIrmPayload,
  cleanIncidentText,
  cleanIncidentTitle,
  incidentAlertUid,
  renderIncidentMessage,
  ReportBudget,
  sendToIrm,
  type IncidentContext,
} from "../services/incidents.js";

const ID = "3f2b6c1e-8a4d-4f0e-9b7a-2c5d8e1f4a6b";

function ctx(over: Partial<IncidentContext> = {}): IncidentContext {
  return {
    id: ID,
    severity: "high",
    title: "ETH reads failing",
    description: "Half our eth_call requests return 502 since 14:00.",
    chain: "ETH1",
    routerId: "eth-prod",
    reporter: { name: "Dana Levi", email: "dana@example.com", phone: null, signedIn: false, role: null },
    dashboardVersion: "0.40.0",
    receivedAt: new Date("2026-10-18T14:02:11.000Z"),
    ...over,
  };
}

describe("incidentAlertUid", () => {
  /** The phone budget: every Critical in one clock hour lands in one IRM
   *  alert group, so the rota is called once for them, not once each. */
  it("gives every Critical in the same UTC hour one key", () => {
    const a = incidentAlertUid("critical", ID, new Date("2026-10-18T14:00:00Z"));
    const b = incidentAlertUid("critical", "another-id", new Date("2026-10-18T14:59:59Z"));
    expect(a).toBe("critical-2026-10-18T14");
    expect(b).toBe(a);
  });

  it("starts a new key, and so a new call, in the next hour", () => {
    expect(incidentAlertUid("critical", ID, new Date("2026-10-18T15:00:00Z"))).toBe("critical-2026-10-18T15");
  });

  /** A retry of the same form must join the report it repeats. */
  it("keys every other severity on the form's own id", () => {
    for (const severity of ["high", "medium", "low"] as const) {
      expect(incidentAlertUid(severity, ID, new Date())).toBe(`report-${ID}`);
    }
  });
});

describe("cleaning free text", () => {
  it("flattens a title to one line without control characters or bidi overrides", () => {
    expect(cleanIncidentTitle("  ETH\u0007 down\n\tagain\u202e  ")).toBe("ETH down again");
    expect(cleanIncidentTitle("\u0000\u001b")).toBe("");
  });

  it("keeps line breaks in a description and drops the rest", () => {
    expect(cleanIncidentText("line one\r\nline two\u0008\n\n\n\nline three ")).toBe("line one\nline two\n\nline three");
  });
});

describe("buildIrmPayload", () => {
  it("carries what the integration's routes and templates read", () => {
    const p = buildIrmPayload(ctx());
    expect(p).toMatchObject({
      alert_uid: `report-${ID}`,
      title: "[High] ETH reads failing",
      state: "alerting",
      severity: "high",
      incident_id: ID,
      reported_at: "2026-10-18T14:02:11.000Z",
      chain: "ETH1",
      router_id: "eth-prod",
      reporter: { name: "Dana Levi", email: "dana@example.com", phone: null, signed_in: false, role: null },
      dashboard_version: "0.40.0",
    });
  });

  /** IRM turns these into links; a report from anyone must not choose one. */
  it("sends no link and no image", () => {
    const p = buildIrmPayload(ctx());
    expect(p).not.toHaveProperty("link_to_upstream_details");
    expect(p).not.toHaveProperty("image_url");
  });

  it("never sends a state that resolves the alert group", () => {
    expect(buildIrmPayload(ctx({ severity: "low" })).state).toBe("alerting");
  });
});

describe("renderIncidentMessage", () => {
  it("says a typed-in reporter was not verified", () => {
    const text = renderIncidentMessage(ctx({ reporter: { ...ctx().reporter, phone: "+972 50 000 0000" } }));
    expect(text).toContain("Reported by: Dana Levi <dana@example.com> · +972 50 000 0000 (typed into the form, not verified)");
    expect(text).toContain("Chain: ETH1 · Router: eth-prod");
    expect(text).toContain(`Incident id: ${ID}`);
  });

  it("names a signed-in reporter's role", () => {
    const text = renderIncidentMessage(
      ctx({ reporter: { name: "Dana Levi", email: "dana@example.com", phone: null, signedIn: true, role: "read_only" } }),
    );
    expect(text).toContain("(signed in, read_only)");
  });

  it("says when there is no description, and leaves out a scope that wasn't given", () => {
    const text = renderIncidentMessage(ctx({ description: null, chain: null, routerId: null }));
    expect(text.split("\n")[0]).toBe("(no description)");
    expect(text).not.toContain("Chain:");
  });
});

describe("ReportBudget", () => {
  it("refuses past the limit and frees a slot once it leaves the window", () => {
    const budget = new ReportBudget(2, 1000);
    expect(budget.take(0)).toBe(true);
    expect(budget.take(10)).toBe(true);
    expect(budget.take(20)).toBe(false);
    expect(budget.take(999)).toBe(false);
    expect(budget.take(1000)).toBe(true);
  });
});

describe("sendToIrm", () => {
  const URL = "https://oncall.example/integrations/v1/formatted_webhook/SECRETID/";

  it("posts JSON and reports a 2xx as accepted", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("Ok.", { status: 200 });
    }) as unknown as typeof fetch;
    const out = await sendToIrm(URL, { a: 1 }, 1000, fake);
    expect(out).toEqual({ ok: true, status: 200 });
    expect(seen!.url).toBe(URL);
    expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ a: 1 });
  });

  it("reports a refusal with its status and never the URL", async () => {
    const fake = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const out = await sendToIrm(URL, {}, 1000, fake);
    expect(out).toEqual({ ok: false, status: 429, reason: "refused" });
    expect(JSON.stringify(out)).not.toContain("SECRETID");
  });

  it("tells a timeout from an unreachable host, without throwing", async () => {
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    expect(await sendToIrm(URL, {}, 20, slow)).toEqual({ ok: false, status: null, reason: "timeout" });

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await sendToIrm(URL, {}, 1000, down)).toEqual({ ok: false, status: null, reason: "unreachable" });
  });
});

describe("readIncidentSettings", () => {
  it("is off unless switched on exactly", () => {
    expect(readIncidentSettings({}).enabled).toBe(false);
    expect(readIncidentSettings({ INCIDENTS_ENABLED: "1" }).enabled).toBe(false);
    expect(readIncidentSettings({ INCIDENTS_ENABLED: "TRUE" }).enabled).toBe(true);
  });

  it("accepts https, and http only for a loopback mock", () => {
    expect(readIncidentSettings({ INCIDENTS_ENABLED: "true", INCIDENT_WEBHOOK_URL: "https://oncall.example/x/" })).toMatchObject({
      webhookUrl: "https://oncall.example/x/",
      problem: null,
    });
    expect(readIncidentSettings({ INCIDENTS_ENABLED: "true", INCIDENT_WEBHOOK_URL: "http://127.0.0.1:9/x" }).problem).toBeNull();
    expect(readIncidentSettings({ INCIDENTS_ENABLED: "true", INCIDENT_WEBHOOK_URL: "http://oncall.example/x" })).toMatchObject({
      webhookUrl: null,
      problem: "INCIDENT_WEBHOOK_URL must be https",
    });
  });

  /** The problem is logged at boot; the URL is a credential and must not be. */
  it("names what is wrong without repeating the value", () => {
    const s = readIncidentSettings({ INCIDENTS_ENABLED: "true", INCIDENT_WEBHOOK_URL: "not a url SECRET" });
    expect(s.problem).toBe("INCIDENT_WEBHOOK_URL is not a URL");
    expect(readIncidentSettings({ INCIDENTS_ENABLED: "true" }).problem).toBe("INCIDENT_WEBHOOK_URL is not set");
  });

  it("raises no problem while switched off", () => {
    expect(readIncidentSettings({}).problem).toBeNull();
  });

  it("takes positive whole limits and falls back on anything else", () => {
    const s = readIncidentSettings({ INCIDENT_RATE_LIMIT_MAX: "5", INCIDENT_POD_MAX: "-1", INCIDENT_WEBHOOK_TIMEOUT_MS: "2.5" });
    expect(s).toMatchObject({ perIpMax: 5, podMax: 10, timeoutMs: 10_000 });
  });
});
