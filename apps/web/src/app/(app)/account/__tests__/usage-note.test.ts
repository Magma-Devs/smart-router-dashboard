import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ apiGet: vi.fn(() => new Promise(() => {})) }));

const { usageNoteText } = await import("../about-deployment");

/* The Account page's line about usage data (MAG-5402): the signed-in person's
   answer, except in a browser that sends Do Not Track, where Mixpanel's SDK
   sends nothing whatever the answer, and the page says so. */

describe("the Account page's usage note", () => {
  it("says on or off by the answer", () => {
    expect(usageNoteText(true, false)).toMatch(/^Analytics are on in this browser:/);
    expect(usageNoteText(false, false)).toMatch(/^Analytics are off in this browser\. On,/);
  });

  it("never says on in a browser that sends Do Not Track", () => {
    for (const on of [true, false]) {
      const text = usageNoteText(on, true);
      expect(text).not.toMatch(/are on/);
      expect(text).toContain("Do Not Track");
      expect(text).toContain("records nothing");
    }
  });
});
