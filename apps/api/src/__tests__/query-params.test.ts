import { describe, expect, it } from "vitest";
import type { RouterTopology } from "@sr/shared";
import {
  isUpstreamName,
  PARAMS,
  ROUTER_ID_PATTERN,
  SCOPE_VALUE,
  SCOPE_VALUE_PATTERN,
  SPEC_PATTERN,
  UPSTREAM_TOKEN,
} from "../services/query-params.js";

const config = (names: string[]) => ({
  getRouters: () => [{ id: "eth-prod", spec: "ETH1", nodes: names.map((name) => ({ name })) } as unknown as RouterTopology],
});

const HOSTILE = ['ETH1"}', "ETH1`", "ETH1{}", "ETH1\\", "ETH1\nup", 'a |= "x"', "a b", "(?i)x", "x".repeat(300), ""];

describe("query-params patterns", () => {
  it("take the values the store and the values file use", () => {
    for (const v of ["ETH1", "COSMOSHUB", "eth_1-test"]) expect(new RegExp(SPEC_PATTERN).test(v), v).toBe(true);
    for (const v of ["Ethereum", "eth-prod", "ETH1", "lava.mainnet:1"]) expect(new RegExp(ROUTER_ID_PATTERN).test(v), v).toBe(true);
    for (const v of ["eth-router", "eth-prod", "serviceMonitor/monitoring/smart-router/0", "10.0.0.1:7779", "a@b+c"]) {
      expect(SCOPE_VALUE.test(v), v).toBe(true);
    }
    for (const v of ["eth-publicnode", "Cached", "node.1:a@b+c"]) expect(UPSTREAM_TOKEN.test(v), v).toBe(true);
  });

  it("refuse quotes, braces, backticks, backslashes, line breaks, spaces, regex syntax and over-long values", () => {
    for (const v of HOSTILE) {
      expect(new RegExp(SPEC_PATTERN).test(v), JSON.stringify(v)).toBe(false);
      expect(new RegExp(ROUTER_ID_PATTERN).test(v), JSON.stringify(v)).toBe(false);
      expect(SCOPE_VALUE.test(v), JSON.stringify(v)).toBe(false);
      expect(UPSTREAM_TOKEN.test(v), JSON.stringify(v)).toBe(false);
    }
  });

  it("are the patterns the route schemas carry", () => {
    expect(PARAMS.spec.pattern).toBe(SPEC_PATTERN);
    expect(PARAMS.routerId.pattern).toBe(ROUTER_ID_PATTERN);
    expect(PARAMS.router.pattern).toBe(SCOPE_VALUE_PATTERN);
    expect(PARAMS.upstream.maxLength).toBe(128);
  });
});

describe("isUpstreamName", () => {
  it("takes a plain token whether or not the values file lists it", () => {
    expect(isUpstreamName("eth-publicnode")).toBe(true);
    expect(isUpstreamName("Cached", config([]))).toBe(true);
  });

  it("takes any name the values file lists, as written", () => {
    const svc = config(['Example "archive" node', "node (eu) #1"]);
    expect(isUpstreamName('Example "archive" node', svc)).toBe(true);
    expect(isUpstreamName("node (eu) #1", svc)).toBe(true);
  });

  it("refuses anything else", () => {
    const svc = config(["eth-a"]);
    for (const v of HOSTILE) expect(isUpstreamName(v, svc), JSON.stringify(v)).toBe(false);
    expect(isUpstreamName("node (eu) #1")).toBe(false);
  });
});
