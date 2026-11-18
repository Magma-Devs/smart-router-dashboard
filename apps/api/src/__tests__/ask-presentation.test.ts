import { describe, expect, it } from "vitest";
import { askAnswerContentSchema } from "@sr/shared";
import { formatAskPresentation } from "../services/ask/presentation.js";

describe("lossless answer formatting before contract validation", () => {
  it("keeps a normal answer unchanged", () => {
    const input = { kind: "conversation", summary: "Hello!", sections: [] };
    expect(formatAskPresentation(input)).toEqual(input);
  });
  it("moves a long explanation into body text without losing or inventing words", () => {
    const first = "Latency is the time it takes for a request to receive a response.";
    const rest = " It is measured in milliseconds and varies between requests.".repeat(10);
    const formatted = formatAskPresentation({ summary: first + rest, sections: [] });
    expect(askAnswerContentSchema.safeParse(formatted).success).toBe(true);
    const sections = formatted.sections as Array<{ body: string }>;
    expect([formatted.summary, ...sections.map((section) => section.body)].join(" ")).toBe(
      (first + rest).trim(),
    );
  });
  it.each(["A", "שלום", "مرحبا", "説明"])("splits long %s prose at a word boundary", (word) => {
    const text = Array.from({ length: 300 }, () => word).join(" ");
    const formatted = formatAskPresentation({ summary: text, sections: [] });
    expect(askAnswerContentSchema.safeParse(formatted).success).toBe(true);
    expect(
      [
        formatted.summary,
        ...(formatted.sections as Array<{ body: string }>).map((section) => section.body),
      ].join(" "),
    ).toBe(text);
  });
  it("only supplies a neutral missing heading, preserving the actual body", () => {
    const formatted = formatAskPresentation({
      summary: "Observed count",
      sections: [{ title: " ", body: "3 requests were recorded." }],
    });
    expect(formatted.sections).toEqual([{ title: "Details", body: "3 requests were recorded." }]);
  });
  it.each([
    { summary: "x".repeat(501), sections: [] },
    { summary: "Observed", sections: "[]" },
    { summary: "Observed", sections: [{ title: 3, body: "Evidence" }] },
    { summary: "Observed", sections: [{ title: "", body: "" }] },
    { summary: "Observed", sections: [], html: "<script>" },
  ])("leaves malformed structures and overlong unbroken tokens invalid %#", (input) => {
    expect(askAnswerContentSchema.safeParse(formatAskPresentation(input)).success).toBe(false);
  });
});
