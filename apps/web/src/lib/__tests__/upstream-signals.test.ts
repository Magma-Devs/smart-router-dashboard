import { describe, expect, it } from "vitest";
import { pollColor, pollSummary } from "../upstream-signals";

describe("pollSummary", () => {
  it("is null when the router does not publish the family at all", () => {
    // An older router: absent is not the same as zero, and the UI omits the
    // row rather than reporting "not polled".
    expect(pollSummary(null)).toBeNull();
  });

  it("says nothing was asked when both counters are zero", () => {
    // NOT "healthy". A poll gate suppresses polls that served traffic or a
    // peer's poll already made redundant, so zero failures proves nothing.
    expect(pollSummary({ ok: 0, failed: 0 })).toBe("none in this window");
  });

  it("says nothing about failures when there were none", () => {
    expect(pollSummary({ ok: 288, failed: 0 })).toBe("288 answered");
  });

  it("names the failures when there were some", () => {
    expect(pollSummary({ ok: 280, failed: 8 })).toBe("280 answered · 8 failed");
    expect(pollSummary({ ok: 0, failed: 12 })).toBe("0 answered · 12 failed");
  });

  it("does not repeat the label it sits under", () => {
    // The field is already labelled "Block polls" — repeating the words in the
    // value is what made this read as a sentence instead of a figure.
    for (const p of [{ ok: 288, failed: 0 }, { ok: 280, failed: 8 }, { ok: 0, failed: 0 }]) {
      expect(pollSummary(p)).not.toMatch(/block|poll/i);
    }
  });

  it("shortens counts that would otherwise dominate the line", () => {
    expect(pollSummary({ ok: 12400, failed: 0 })).toBe("12.4k answered");
  });
});

describe("pollColor", () => {
  it("stays neutral for both cases it cannot judge", () => {
    expect(pollColor(null)).toBe("var(--text-4)");
    expect(pollColor({ ok: 0, failed: 0 })).toBe("var(--text-4)");
  });

  it("separates a clean run from a partial failure from a total one", () => {
    expect(pollColor({ ok: 288, failed: 0 })).toBe("var(--ok)");
    expect(pollColor({ ok: 280, failed: 8 })).toBe("var(--warn)");
    expect(pollColor({ ok: 0, failed: 12 })).toBe("var(--err)");
  });
});
