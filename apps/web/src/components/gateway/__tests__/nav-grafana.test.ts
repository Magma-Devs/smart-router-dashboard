import { describe, expect, it } from "vitest";
import { visibleNavSections } from "../nav";

const reportsUrl = "https://magmadevs.grafana.net/d/sr-gk8-interactive-war-room/gk8-e28094-customer-experience?from=now-5m&to=now&timezone=browser&var-chain=$__all&var-provider=$__all&refresh=5m";

describe("customer Grafana navigation", () => {
  it.each([true, false])("adds the reports link after the existing sections (auth=%s)", (authEnabled) => {
    const baseline = visibleNavSections(authEnabled);
    const sections = visibleNavSections(authEnabled, reportsUrl);
    expect(sections.slice(0, -1)).toEqual(baseline);
    expect(sections.at(-1)).toMatchObject({
      label: "Advanced",
      items: [{ label: "Grafana", href: reportsUrl, external: true }],
    });
    expect(sections.at(-1)?.items[0]?.icon).toBeTypeOf("function");
  });

  it.each([undefined, null, "", " \t\n ", "javascript:alert(1)", "/d/reports"])(
    "hides the entire section for %j",
    (url) => {
      const sections = visibleNavSections(true, url);
      expect(sections).toEqual(visibleNavSections(true));
      expect(sections.some((section) => section.label === "Advanced")).toBe(false);
    },
  );

  it("does not carry a configured URL into another customer's navigation", () => {
    expect(visibleNavSections(false, reportsUrl).at(-1)?.label).toBe("Advanced");
    expect(visibleNavSections(false).some((section) => section.label === "Advanced")).toBe(false);
  });
});
