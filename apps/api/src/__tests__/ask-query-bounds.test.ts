import { describe, expect, it } from "vitest";
import { hasBoundedAskQuery } from "../services/ask/query-bounds.js";

describe("bounded Ask query dialect", () => {
  it.each([
    "up",
    "rate(requests_total[5m])",
    "sum(rate(requests_total[1h30m]))",
    "up[86400]",
    "up[8.64e4]",
    'up{label="offset 100y [100y] @1"}',
    "up{label='[100y]'}",
    'count_over_time({app="router"} |= `offset 100y [100y] @1` [5m])',
    String.raw`up{label="escaped \" [100y]"}[5m]`,
    "rate(up[5m]) # [100y] offset 100y\n",
    "a[12h] + b[12h]",
  ])("accepts bounded reads and treats quoted/comment data as data: %s", (query) =>
    expect(hasBoundedAskQuery(query)).toBe(true),
  );
  it.each([
    "rate(up[365d])",
    "up offset 365d",
    "rate(up[5m] OFFSET 30d)",
    "up Offset 365d",
    "up offset(1h * 1000)",
    "up @ 1",
    "up @ start()",
    "rate(up[1h])[24h:1s]",
    "rate(up[1h])[24h:]",
    "up[1h * 1000]",
    "up[(5+2)*1d]",
    "up[step()*100000]",
    "up[1e99]",
    "up[0]",
    "up[-1h]",
    "a[13h] + b[12h]",
    "up[1m",
    "up]",
    "up[[5m]]",
    'up{label="unterminated}',
  ])("refuses unbounded, relocated or unsupported time syntax: %s", (query) =>
    expect(hasBoundedAskQuery(query)).toBe(false),
  );
});
