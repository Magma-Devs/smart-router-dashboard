import { describe, expect, it } from "vitest";
import { visibleNavSections } from "../nav";

describe("the Providers page in the menu", () => {
  it("sits beside Metrics and Upstreams", () => {
    const labels = visibleNavSections(false, null).flatMap((s) => s.items.map((i) => i.label));
    expect(labels.slice(0, 3)).toEqual(["Metrics", "Upstreams", "Providers"]);
  });
});
