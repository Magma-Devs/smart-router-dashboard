import { describe, expect, it } from "vitest";
import { UNHEALTHY_FAILED_SHARE, upstreamCellState } from "../utils/upstream-state.js";

const none = { rps: null, failedRps: null, pollsOk: null, pollsFailed: null };

describe("upstreamCellState", () => {
  it("no sample on any series is a gap, not a health", () => {
    expect(upstreamCellState(none)).toBeNull();
  });

  it("scraped but neither tried nor polled is unknown, never operational", () => {
    expect(upstreamCellState({ rps: 0, failedRps: 0, pollsOk: 0, pollsFailed: 0 })).toBe("unknown");
    expect(upstreamCellState({ ...none, pollsOk: 0 })).toBe("unknown");
  });

  it("tries that mostly succeeded read operational", () => {
    expect(upstreamCellState({ ...none, rps: 10, failedRps: 1 })).toBe("operational");
  });

  it("half or more of the tries failing is unhealthy", () => {
    expect(UNHEALTHY_FAILED_SHARE).toBe(0.5);
    expect(upstreamCellState({ ...none, rps: 10, failedRps: 5 })).toBe("unhealthy");
    expect(upstreamCellState({ ...none, rps: 10, failedRps: 10, pollsOk: 3 })).toBe("unhealthy");
  });

  it("an upstream with no tries reads from its polls", () => {
    expect(upstreamCellState({ ...none, pollsOk: 2, pollsFailed: 1 })).toBe("operational");
    expect(upstreamCellState({ ...none, pollsOk: 0, pollsFailed: 3 })).toBe("unhealthy");
    expect(upstreamCellState({ ...none, pollsFailed: 3 })).toBe("unhealthy");
  });

  it("every poll failing is unhealthy even while tries succeed, as current health reads it", () => {
    expect(upstreamCellState({ rps: 4, failedRps: 0, pollsOk: 0, pollsFailed: 2 })).toBe("unhealthy");
  });

  it("a failed rate above the tries (counter noise) counts as every try failing", () => {
    expect(upstreamCellState({ ...none, rps: 1, failedRps: 1.0000001 })).toBe("unhealthy");
  });
});
