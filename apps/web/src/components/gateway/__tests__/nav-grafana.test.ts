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
      items: [{ label: "Logs & Metrics", href: reportsUrl, external: true }],
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

const usageUrl = "https://magmadevs.grafana.net/d/sr-gk8-customer-usage?from=now-24h&to=now&var-chain=$__all&var-interface=$__all&var-customer=$__all&refresh=5m";

describe("Customer Usage navigation", () => {
  it.each([true, false])("shows both independent links in order (auth=%s)", (authEnabled) => {
    expect(visibleNavSections(authEnabled, reportsUrl, usageUrl).at(-1)).toMatchObject({
      label: "Advanced",
      items: [
        { label: "Logs & Metrics", href: reportsUrl, external: true },
        { label: "Customer Usage", href: usageUrl, external: true },
      ],
    });
  });

  it("shows usage alone when Logs & Metrics is unset", () => {
    expect(visibleNavSections(false, null, usageUrl).at(-1)).toMatchObject({
      label: "Advanced",
      items: [{ label: "Customer Usage", href: usageUrl, external: true }],
    });
  });

  it.each([undefined, null, "", " \t\n ", "javascript:alert(1)", "/d/usage", "https://user:password@example.com"])(
    "hides invalid or missing usage independently: %j",
    (url) => {
      expect(visibleNavSections(true, reportsUrl, url)).toEqual(visibleNavSections(true, reportsUrl));
      expect(visibleNavSections(true, null, url)).toEqual(visibleNavSections(true));
    },
  );

  it("does not reuse another deployment's usage URL", () => {
    expect(visibleNavSections(false, null, usageUrl).at(-1)?.items).toHaveLength(1);
    expect(visibleNavSections(false).some((section) => section.label === "Advanced")).toBe(false);
  });
});
