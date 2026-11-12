import { describe, expect, it } from "vitest";
import {
  dexConnectorOf,
  readDexClient,
  readDexConnectors,
  readProviderRoutes,
  signInTarget,
} from "../lib/sign-in-routes";

/**
 * Which way each social button goes (MAG-5238). The login page, the invitation
 * page and the Auth.js config all read this one answer; a button that starts a
 * flow Auth.js did not register is a button that fails after the click.
 */

const DEX = { DEX_ISSUER: "https://auth.example.com", DEX_CLIENT_ID: "sr-dashboard-acme" };
const DIRECT = {
  GOOGLE_CLIENT_ID: "g-id",
  GOOGLE_CLIENT_SECRET: "g-secret",
  GITHUB_CLIENT_ID: "gh-id",
  GITHUB_CLIENT_SECRET: "gh-secret",
};

describe("readDexClient", () => {
  it("needs both halves", () => {
    expect(readDexClient(DEX)).toEqual({ issuer: "https://auth.example.com", clientId: "sr-dashboard-acme" });
    expect(readDexClient({ DEX_ISSUER: DEX.DEX_ISSUER })).toBeNull();
    expect(readDexClient({ DEX_CLIENT_ID: DEX.DEX_CLIENT_ID })).toBeNull();
  });

  it("refuses an issuer the api would refuse", () => {
    for (const issuer of ["auth.example.com", "http://auth.example.com", "https://auth.example.com?x=1"]) {
      expect(readDexClient({ ...DEX, DEX_ISSUER: issuer })).toBeNull();
    }
    expect(readDexClient({ ...DEX, DEX_ISSUER: "http://localhost:5556/dex" })).not.toBeNull();
  });
});

describe("readDexConnectors", () => {
  it("defaults to both, and drops names it does not know", () => {
    expect(readDexConnectors({})).toEqual(["google", "github"]);
    expect(readDexConnectors({ DEX_CONNECTORS: " " })).toEqual(["google", "github"]);
    expect(readDexConnectors({ DEX_CONNECTORS: "GitHub, ldap" })).toEqual(["github"]);
    expect(readDexConnectors({ DEX_CONNECTORS: "ldap" })).toEqual([]);
  });
});

describe("readProviderRoutes", () => {
  it("offers nothing with nothing configured", () => {
    expect(readProviderRoutes({})).toEqual({ google: null, github: null });
  });

  it("goes direct with a provider's own pair, and only with both halves", () => {
    expect(readProviderRoutes(DIRECT)).toEqual({ google: "direct", github: "direct" });
    expect(readProviderRoutes({ GOOGLE_CLIENT_ID: "g-id" })).toEqual({ google: null, github: null });
  });

  it("goes through Dex for every connector it lists", () => {
    expect(readProviderRoutes(DEX)).toEqual({ google: "dex", github: "dex" });
    expect(readProviderRoutes({ ...DEX, DEX_CONNECTORS: "github" })).toEqual({ google: null, github: "dex" });
  });

  it("prefers Dex per provider, leaving an unlisted one on its direct pair", () => {
    expect(readProviderRoutes({ ...DIRECT, ...DEX })).toEqual({ google: "dex", github: "dex" });
    expect(readProviderRoutes({ ...DIRECT, ...DEX, DEX_CONNECTORS: "google" })).toEqual({
      google: "dex",
      github: "direct",
    });
  });

  it("falls back to the direct pairs when the Dex settings are half set", () => {
    expect(readProviderRoutes({ ...DIRECT, DEX_ISSUER: DEX.DEX_ISSUER })).toEqual({
      google: "direct",
      github: "direct",
    });
  });
});

describe("signInTarget", () => {
  it("sends a Dex button to the dex provider with the connector to skip straight to", () => {
    expect(signInTarget("github", { google: null, github: "dex" })).toEqual({
      provider: "dex",
      params: { connector_id: "github" },
    });
  });

  it("sends a direct button to its own provider, with nothing extra", () => {
    expect(signInTarget("google", { google: "direct", github: null })).toEqual({ provider: "google" });
  });
});

describe("dexConnectorOf", () => {
  it("reads the provider from federated_claims, and nothing else", () => {
    expect(dexConnectorOf({ federated_claims: { connector_id: "github", user_id: "1" } })).toBe("github");
    expect(dexConnectorOf({ federated_claims: { connector_id: "ldap" } })).toBeNull();
    expect(dexConnectorOf({})).toBeNull();
    expect(dexConnectorOf(undefined)).toBeNull();
  });
});
