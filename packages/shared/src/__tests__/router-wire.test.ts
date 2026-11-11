import { describe, expect, it } from "vitest";
import {
  ROUTER_DIRECTIVE_HEADERS,
  ROUTER_REPLY_HEADERS,
  readRouterHeader,
  routerDirectiveHeaders,
  routerWireNames,
} from "../index.js";

describe("the router's wire names", () => {
  it("spells each reply header as the router does after its rename and before it", () => {
    // From smart-router's protocol/common/endpoints.go, on either side of the
    // rename. The cross-validation headers follow the directive rule
    // (`lava-` → `smartrouter-`), not the reply-header one.
    expect(ROUTER_REPLY_HEADERS).toEqual({
      providerAddress: {
        current: "Smart-Router-Provider-Address",
        legacy: "Lava-Provider-Address",
      },
      retries: { current: "Smart-Router-Retries", legacy: "Lava-Retries" },
      guid: { current: "Smart-Router-Guid", legacy: "Lava-Guid" },
      crossValidationStatus: {
        current: "smartrouter-cross-validation-status",
        legacy: "lava-cross-validation-status",
      },
      crossValidationAgreeing: {
        current: "smartrouter-cross-validation-agreeing-providers",
        legacy: "lava-cross-validation-agreeing-providers",
      },
      crossValidationDisagreeing: {
        current: "smartrouter-cross-validation-disagreeing-providers",
        legacy: "lava-cross-validation-disagreeing-providers",
      },
    });
  });

  it("spells each directive both ways", () => {
    expect(ROUTER_DIRECTIVE_HEADERS).toEqual({
      selectProvider: { current: "smartrouter-select-provider", legacy: "lava-select-provider" },
      forceCacheRefresh: {
        current: "smartrouter-force-cache-refresh",
        legacy: "lava-force-cache-refresh",
      },
    });
  });

  it("no name is spelled the same in both generations", () => {
    for (const name of [
      ...Object.values(ROUTER_REPLY_HEADERS),
      ...Object.values(ROUTER_DIRECTIVE_HEADERS),
    ]) {
      expect(name.current.toLowerCase()).not.toBe(name.legacy.toLowerCase());
      expect(name.current.toLowerCase()).not.toContain("lava");
    }
  });
});

describe("routerWireNames", () => {
  it("lists the current spelling first", () => {
    expect(routerWireNames(ROUTER_REPLY_HEADERS.retries)).toEqual([
      "Smart-Router-Retries",
      "Lava-Retries",
    ]);
  });
});

describe("readRouterHeader", () => {
  it("reads a router's reply after the rename", () => {
    const reply = new Headers({
      "Smart-Router-Provider-Address": "eth-publicnode",
      "Smart-Router-Retries": "2",
    });
    expect(readRouterHeader(reply, ROUTER_REPLY_HEADERS.providerAddress)).toBe("eth-publicnode");
    expect(readRouterHeader(reply, ROUTER_REPLY_HEADERS.retries)).toBe("2");
  });

  it("reads a router's reply from before the rename", () => {
    const reply = new Headers({ "Lava-Provider-Address": "eth-publicnode", "Lava-Retries": "2" });
    expect(readRouterHeader(reply, ROUTER_REPLY_HEADERS.providerAddress)).toBe("eth-publicnode");
    expect(readRouterHeader(reply, ROUTER_REPLY_HEADERS.retries)).toBe("2");
  });

  it("reads either in any letter case, as HTTP header names are", () => {
    expect(
      readRouterHeader(new Headers({ "smart-router-guid": "7" }), ROUTER_REPLY_HEADERS.guid),
    ).toBe("7");
    expect(readRouterHeader(new Headers({ "LAVA-GUID": "7" }), ROUTER_REPLY_HEADERS.guid)).toBe(
      "7",
    );
    expect(
      readRouterHeader(
        new Headers({ "Smartrouter-Cross-Validation-Status": "agreed" }),
        ROUTER_REPLY_HEADERS.crossValidationStatus,
      ),
    ).toBe("agreed");
    expect(
      readRouterHeader(
        new Headers({ "Lava-Cross-Validation-Status": "agreed" }),
        ROUTER_REPLY_HEADERS.crossValidationStatus,
      ),
    ).toBe("agreed");
  });

  it("takes the current spelling when a reply carries both", () => {
    const reply = new Headers({
      "Lava-Provider-Address": "old",
      "Smart-Router-Provider-Address": "new",
    });
    expect(readRouterHeader(reply, ROUTER_REPLY_HEADERS.providerAddress)).toBe("new");
  });

  it("is null when the reply carries neither", () => {
    expect(
      readRouterHeader(
        new Headers({ "content-type": "application/json" }),
        ROUTER_REPLY_HEADERS.retries,
      ),
    ).toBeNull();
  });

  it("keeps an empty value: an empty disagreeing list says nobody disagreed", () => {
    for (const name of routerWireNames(ROUTER_REPLY_HEADERS.crossValidationDisagreeing)) {
      expect(
        readRouterHeader(
          new Headers({ [name]: "" }),
          ROUTER_REPLY_HEADERS.crossValidationDisagreeing,
        ),
      ).toBe("");
    }
    // An empty current header is the answer, even next to a legacy one.
    const both = new Headers({
      "smartrouter-cross-validation-disagreeing-providers": "",
      "lava-cross-validation-disagreeing-providers": "a",
    });
    expect(readRouterHeader(both, ROUTER_REPLY_HEADERS.crossValidationDisagreeing)).toBe("");
  });
});

describe("routerDirectiveHeaders", () => {
  it("sends each directive under both spellings, the current one first", () => {
    const headers = routerDirectiveHeaders({
      selectProvider: "eth-publicnode",
      forceCacheRefresh: true,
    });
    expect(headers).toEqual({
      "smartrouter-select-provider": "eth-publicnode",
      "lava-select-provider": "eth-publicnode",
      "smartrouter-force-cache-refresh": "true",
      "lava-force-cache-refresh": "true",
    });
    expect(Object.keys(headers)).toEqual([
      "smartrouter-select-provider",
      "lava-select-provider",
      "smartrouter-force-cache-refresh",
      "lava-force-cache-refresh",
    ]);
  });

  it("sends only the directive that is set", () => {
    expect(routerDirectiveHeaders({ selectProvider: "a" })).toEqual({
      "smartrouter-select-provider": "a",
      "lava-select-provider": "a",
    });
    expect(routerDirectiveHeaders({ forceCacheRefresh: true })).toEqual({
      "smartrouter-force-cache-refresh": "true",
      "lava-force-cache-refresh": "true",
    });
  });

  it("sends nothing for a directive that is unset, empty or off", () => {
    expect(routerDirectiveHeaders({})).toEqual({});
    expect(routerDirectiveHeaders({ selectProvider: "", forceCacheRefresh: false })).toEqual({});
    expect(routerDirectiveHeaders({ selectProvider: undefined })).toEqual({});
  });
});
