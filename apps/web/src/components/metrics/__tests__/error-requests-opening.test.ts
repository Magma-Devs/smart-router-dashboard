import { describe, expect, it } from "vitest";
import { openingResult } from "../ErrorRequests";

describe("openingResult - what the Errors list shows before anyone picks a result", () => {
  it("opens on the requests that reached the client when there are any", () => {
    expect(openingResult(3, false)).toBe("reached");
  });

  it("opens on every request when none reached the client", () => {
    expect(openingResult(0, false)).toBe("all");
  });

  it("opens on every request from a bar on the Upstreams tab, which counts recovered tries too", () => {
    expect(openingResult(3, true)).toBe("all");
    expect(openingResult(0, true)).toBe("all");
  });
});
