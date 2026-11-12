import { describe, expect, it } from "vitest";
import { nothingReachedWords, openingResult } from "../ErrorRequests";

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

describe("nothingReachedWords - the line above a list in which nothing reached the client", () => {
  const recovered = { result: "recovered" as const };
  const noEnd = { result: "unknown" as const };

  it("speaks for every request when no filter is set", () => {
    expect(nothingReachedWords([recovered, recovered], false, "in the last 1 hour"))
      .toBe("No error reached the client in the last 1 hour. The requests below hit an error on the way and were recovered.");
  });

  it("speaks only for the filtered requests under a filter", () => {
    expect(nothingReachedWords([recovered], true, "in this period")).toMatch(/^None of these requests reached the client in this period\./);
  });

  it("does not call a request with no end in the logs recovered", () => {
    expect(nothingReachedWords([recovered, noEnd], false, "in this period"))
      .toBe("No error reached the client in this period. The requests below hit an error on the way: 1 with no end in the logs, the rest recovered.");
    expect(nothingReachedWords([noEnd], false, "in this period")).not.toMatch(/recovered/);
  });
});
