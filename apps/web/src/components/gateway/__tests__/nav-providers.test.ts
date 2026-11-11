import { describe, expect, it } from "vitest";
import { visibleNavSections } from "../nav";

const labels = (newUi: boolean) =>
  visibleNavSections(false, null, newUi).flatMap((s) => s.items.map((i) => i.label));

describe("the Providers page in the menu", () => {
  it("sits beside Metrics and Upstreams on the 0.28 screens", () => {
    expect(labels(true).slice(0, 3)).toEqual(["Metrics", "Upstreams", "Providers"]);
  });

  // The 0.27 screens have no Providers page: an entry would lead to a 404.
  it("is not drawn on the 0.27 screens", () => {
    expect(labels(false)).not.toContain("Providers");
  });
});
