import { describe, expect, it, vi } from "vitest";
import { openRequestSearch, requestSearchUrl } from "../request-search";

describe("requestSearchUrl", () => {
  it("opens the Metrics page's Find a request tab on the ID, in the chain and router in view", () => {
    expect(requestSearchUrl("  abc-123 ", { chain: null, router: null })).toBe("/metrics?tab=request&request=abc-123");
    expect(requestSearchUrl("abc", { chain: "ETH1", router: "eth-prod" })).toBe("/metrics?chain=ETH1&router=eth-prod&tab=request&request=abc");
  });

  it("encodes what a hash or a caller's id may carry", () => {
    expect(requestSearchUrl("a+b=c@d", { chain: null, router: null })).toBe("/metrics?tab=request&request=a%2Bb%3Dc%40d");
  });
});

describe("openRequestSearch", () => {
  it("navigates from any other page", () => {
    const push = vi.fn();
    openRequestSearch("abc", { chain: "BASE", router: null }, "/upstreams", push);
    expect(push).toHaveBeenCalledWith("/metrics?chain=BASE&tab=request&request=abc");
  });

  it("on the Metrics page pushes the URL and tells the page, so Back returns to the view before", () => {
    // The tests run without a browser: the two things the function touches, stubbed.
    const pushState = vi.fn();
    const dispatchEvent = vi.fn();
    class FakePopState { constructor(public type: string) {} }
    vi.stubGlobal("window", { history: { pushState }, dispatchEvent });
    vi.stubGlobal("PopStateEvent", FakePopState);
    try {
      const push = vi.fn();
      openRequestSearch("abc", { chain: null, router: null }, "/metrics", push);
      expect(push).not.toHaveBeenCalled();
      expect(pushState).toHaveBeenCalledWith(null, "", "/metrics?tab=request&request=abc");
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({ type: "popstate" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
