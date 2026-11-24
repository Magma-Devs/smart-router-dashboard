import { describe, expect, it } from "vitest";
import { assertAskRead } from "../services/ask/mcp.js";
import { askQueryLookbackSeconds } from "../services/ask/query-bounds.js";
import { prefetchRead, summarizePrefetch } from "../services/ask/prefetch.js";
import { readLabel } from "../services/ask/progress.js";

const end = 1_795_377_600;
const matrix = (series: { metric: Record<string, string>; values: [number, string][] }[]) => ({
  status: "success",
  data: { resultType: "matrix", result: series },
});

describe("the counts read before the first turn", () => {
  it("is one range read the Ask read policy admits: one-hour selectors, a 23-hour range", () => {
    const read = prefetchRead(end);
    expect(() => assertAskRead(read.operationId, read.parameters)).not.toThrow();
    expect(askQueryLookbackSeconds(read.parameters.query)).toBe(3600);
    expect(read.parameters).toMatchObject({ start: end - 23 * 3600, end, step: 3600 });
    expect(read.window).toEqual({ start: end - 86_400, end, partial: true });
  });

  it("totals each chain's hours and takes the last hour from the point at the read's end", () => {
    expect(
      summarizePrefetch(
        matrix([
          {
            metric: { count: "requests", chain: "eth1" },
            values: [
              [end - 7200, "10"],
              [end, "4.0000001"],
            ],
          },
          { metric: { count: "failures", chain: "eth1" }, values: [[end - 7200, "3"]] },
          { metric: { count: "failures", chain: "base" }, values: [[end, "1"]] },
          {
            metric: { count: "router_lines" },
            values: [
              [end - 3600, "50"],
              [end, "0"],
            ],
          },
        ]),
        end,
      ),
    ).toEqual({
      recordingLive: true,
      hoursWithRouterLines: 1,
      chains: [
        {
          chain: "eth1",
          requestsLastHour: 4,
          failuresLastHour: 0,
          requestsLast24Hours: 14,
          failuresLast24Hours: 3,
          probeRequestsLastHour: 0,
          probeFailuresLastHour: 0,
          probeRequestsLast24Hours: 0,
          probeFailuresLast24Hours: 0,
        },
        {
          chain: "base",
          requestsLastHour: 0,
          failuresLastHour: 1,
          requestsLast24Hours: 0,
          failuresLast24Hours: 1,
          probeRequestsLastHour: 0,
          probeFailuresLastHour: 0,
          probeRequestsLast24Hours: 0,
          probeFailuresLast24Hours: 0,
        },
      ],
    });
  });

  it("gives each chain the serving probe's share, read by chain and never past the count it is part of", () => {
    const counts = summarizePrefetch(
      matrix([
        {
          metric: { count: "requests", chain: "eth1" },
          values: [
            [end - 3600, "100"],
            [end, "60"],
          ],
        },
        { metric: { count: "failures", chain: "eth1" }, values: [[end, "2"]] },
        {
          metric: { count: "probe_requests", chain: "eth1" },
          values: [
            [end - 3600, "60"],
            [end, "60"],
          ],
        },
        { metric: { count: "probe_failures", chain: "eth1" }, values: [[end, "5"]] },
        { metric: { count: "probe_requests", chain: "base" }, values: [[end, "60"]] },
        { metric: { count: "router_lines" }, values: [[end, "1"]] },
      ]),
      end,
    );
    expect(counts?.chains).toEqual([
      {
        chain: "eth1",
        requestsLastHour: 60,
        failuresLastHour: 2,
        requestsLast24Hours: 160,
        failuresLast24Hours: 2,
        probeRequestsLastHour: 60,
        probeFailuresLastHour: 2,
        probeRequestsLast24Hours: 120,
        probeFailuresLast24Hours: 2,
      },
    ]);
  });

  it("reads an idle tenant as live with no chains, and a stopped recording as not live", () => {
    const idle = summarizePrefetch(
      matrix([{ metric: { count: "router_lines" }, values: [[end, "12"]] }]),
      end,
    );
    expect(idle).toEqual({ recordingLive: true, hoursWithRouterLines: 1, chains: [] });
    expect(summarizePrefetch(matrix([]), end)).toEqual({
      recordingLive: false,
      hoursWithRouterLines: 0,
      chains: [],
    });
  });

  it("returns null for anything but a well-formed matrix", () => {
    expect(
      summarizePrefetch({ status: "success", data: { resultType: "vector", result: [] } }, end),
    ).toBeNull();
    expect(summarizePrefetch(null, end)).toBeNull();
    expect(
      summarizePrefetch(
        matrix([{ metric: { count: "requests", chain: "eth1" }, values: [[end, "x"]] }]),
        end,
      ),
    ).toBeNull();
    expect(
      summarizePrefetch(
        {
          status: "success",
          data: {
            resultType: "matrix",
            result: [{ metric: { count: "requests" }, values: [[end]] }],
          },
        },
        end,
      ),
    ).toBeNull();
  });
});

describe("the counts read's source label", () => {
  it("is the progress list's name for the series it selects", () => {
    expect(readLabel("metrics.query_range", prefetchRead(end).parameters)).toBe(
      "Request counts and failure counts and log line counts",
    );
  });
});
