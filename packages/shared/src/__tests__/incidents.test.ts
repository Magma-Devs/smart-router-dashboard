import { describe, expect, it } from "vitest";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_DESCRIPTIONS,
  INCIDENT_SEVERITY_NEXT,
  isIncidentSeverity,
  newIncidentId,
} from "../index.js";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newIncidentId", () => {
  it("mints a version-4 UUID the api's pattern accepts", () => {
    const id = newIncidentId();
    expect(id).toMatch(V4);
    expect(newIncidentId()).not.toBe(id);
  });

  it("sets the version and variant bits whatever the random bytes are", () => {
    expect(newIncidentId((b) => b.fill(0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(newIncidentId((b) => b.fill(0x00))).toBe("00000000-0000-4000-8000-000000000000");
  });
});

describe("incident severities", () => {
  it("recognises the four severities and nothing else", () => {
    for (const s of INCIDENT_SEVERITIES) expect(isIncidentSeverity(s)).toBe(true);
    expect(isIncidentSeverity("urgent")).toBe(false);
    expect(isIncidentSeverity("toString")).toBe(false);
    expect(isIncidentSeverity(null)).toBe(false);
  });

  /** Only Critical may promise a call; the reporter decides on these words. */
  it("tells the reporter which severity calls someone", () => {
    expect(INCIDENT_SEVERITY_DESCRIPTIONS.critical).toMatch(/calls our on-call/i);
    for (const s of ["high", "medium", "low"] as const) {
      expect(INCIDENT_SEVERITY_DESCRIPTIONS[s]).not.toMatch(/calls our on-call/i);
      expect(INCIDENT_SEVERITY_NEXT[s]).not.toMatch(/being called/i);
    }
    expect(INCIDENT_SEVERITY_NEXT.critical).toMatch(/being called/i);
  });
});
