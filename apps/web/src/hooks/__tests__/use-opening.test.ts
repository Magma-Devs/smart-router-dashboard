import { describe, expect, it } from "vitest";
import { settleOpening, type Opening } from "../use-opening";
import { openingResult } from "@/components/metrics/ErrorRequests";

/** One read of the Errors list as the list sees it: its key (times · chain ·
 *  router), whether the logs answered, how many requests reached the client. */
interface Read {
  key?: string;
  answered?: boolean;
  reached: number;
  fromBar?: boolean;
}

const WINDOW_1H = "window=1h||";

/** The result filter the list shows after each read, nobody having picked one. */
function shownAfter(reads: Read[]): string[] {
  let opening: Opening<ReturnType<typeof openingResult>> | null = null;
  return reads.map(({ key = WINDOW_1H, answered = true, reached, fromBar = false }) => {
    opening = settleOpening(opening, key, answered, () => openingResult(reached, fromBar));
    return opening?.value ?? "all";
  });
}

describe("settleOpening - the Errors list's opening filter is chosen once, not on every poll", () => {
  it("keeps \"Reached the client\" when a later poll finds none: they aged out of the window", () => {
    expect(shownAfter([{ reached: 3 }, { reached: 0 }, { reached: 0 }])).toEqual(["reached", "reached", "reached"]);
  });

  it("keeps every request when a later poll brings one that reached the client", () => {
    expect(shownAfter([{ reached: 0 }, { reached: 2 }, { reached: 5 }])).toEqual(["all", "all", "all"]);
  });

  it("does not flip back and forth as requests arrive and age out", () => {
    expect(shownAfter([{ reached: 1 }, { reached: 0 }, { reached: 4 }, { reached: 0 }])).toEqual(["reached", "reached", "reached", "reached"]);
  });

  it("chooses again when the window, the chain or the router changes", () => {
    expect(shownAfter([
      { reached: 2 },
      { reached: 0 },
      { key: "window=6h||", reached: 0 },
      { key: "window=6h|ETH1|", reached: 3 },
      { key: "window=6h|ETH1|&routerId=eth-b", reached: 0 },
      { key: "window=6h|ETH1|&routerId=eth-b", reached: 7 },
    ])).toEqual(["reached", "reached", "all", "reached", "all", "all"]);
  });

  it("chooses again for exact times picked in the list", () => {
    expect(shownAfter([{ reached: 2 }, { key: "from=1000&to=2000||", reached: 0 }, { key: "from=1000&to=2000||", reached: 9 }]))
      .toEqual(["reached", "all", "all"]);
  });

  it("opened from an Upstreams bar, stays on every request whatever later polls bring", () => {
    expect(shownAfter([{ reached: 3, fromBar: true }, { reached: 5, fromBar: true }, { reached: 5, fromBar: false }]))
      .toEqual(["all", "all", "all"]);
  });

  it("waits for a read the logs answered: one they didn't is no reason to open on every request", () => {
    expect(shownAfter([{ answered: false, reached: 0 }, { answered: false, reached: 0 }, { reached: 2 }, { reached: 0 }]))
      .toEqual(["all", "all", "reached", "reached"]);
  });

  it("returns the same opening while the key holds, so the hook stores nothing new", () => {
    const first = settleOpening<string>(null, "k", true, () => "reached");
    expect(settleOpening(first, "k", true, () => "all")).toBe(first);
    expect(settleOpening(first, "k", false, () => "all")).toBe(first);
  });

  it("has none until the list's first read answers, and drops the last list's on a new key until then", () => {
    expect(settleOpening<string>(null, "k", false, () => "reached")).toBeNull();
    const first = settleOpening<string>(null, "k", true, () => "reached");
    expect(settleOpening(first, "k2", false, () => "all")).toBeNull();
  });
});
