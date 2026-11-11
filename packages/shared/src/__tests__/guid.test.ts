import { describe, expect, it } from "vitest";
import { GUID_MAX_AGE_SEC, GUID_MAX_AHEAD_SEC, guidMintedSecond } from "../index.js";

/** A GUID as smart-router v1.6.1 mints it: the second over a per-process counter. */
const mint = (sec: number, counter: number) => ((BigInt(sec) << 32n) | BigInt(counter)).toString();

const NOW = 1_792_323_767; // 2026-10-18

describe("guidMintedSecond", () => {
  it("reads the second out of a v1.6.1 GUID, whatever its counter", () => {
    expect(mint(NOW, 2_846_153_517)).toBe("7697971965954677549");
    expect(guidMintedSecond("7697971965954677549", NOW + 2)).toBe(NOW);
    for (const counter of [0, 1, 2 ** 31, 2 ** 32 - 1]) expect(guidMintedSecond(mint(NOW - 3_600, counter), NOW)).toBe(NOW - 3_600);
  });

  it("an older router's random GUIDs decode to an implausible second", () => {
    // Captured from 1.5.x routers.
    for (const g of ["2933472877181550523", "15972212763463815960", "13101775707732352358", "9946532266546017239", "6955311520133973510"]) {
      expect(guidMintedSecond(g, NOW)).toBeNull();
    }
    // 100,000 random 64-bit GUIDs (a fixed seed): about 0.06% land on a plausible second.
    let seed = 0x9e3779b9;
    const next32 = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
    let plausible = 0;
    for (let i = 0; i < 100_000; i++) {
      const g = ((BigInt(next32()) << 32n) | BigInt(next32())).toString();
      if (guidMintedSecond(g, NOW) !== null) plausible++;
    }
    expect(plausible / 100_000).toBeLessThan(0.001);
  });

  it("takes a second from 30 days back to 5 minutes ahead, and nothing outside", () => {
    expect(GUID_MAX_AGE_SEC).toBe(30 * 86_400);
    expect(guidMintedSecond(mint(NOW - GUID_MAX_AGE_SEC, 7), NOW)).toBe(NOW - GUID_MAX_AGE_SEC);
    expect(guidMintedSecond(mint(NOW - GUID_MAX_AGE_SEC - 1, 7), NOW)).toBeNull();
    expect(guidMintedSecond(mint(NOW + GUID_MAX_AHEAD_SEC, 7), NOW)).toBe(NOW + GUID_MAX_AHEAD_SEC);
    expect(guidMintedSecond(mint(NOW + GUID_MAX_AHEAD_SEC + 1, 7), NOW)).toBeNull();
  });

  it("an ID that isn't a decimal number is none", () => {
    for (const g of ["", "abc", "12ab", "-7697971965954677549", "+7697971965954677549", " 7697971965954677549", "7697971965954677549 ", "7.6e18", "0x6ad4f2b7a9a5d72d", "7697971965954677549.0"]) {
      expect(guidMintedSecond(g, NOW)).toBeNull();
    }
  });

  it("leading zeros are none: the router never writes them", () => {
    expect(guidMintedSecond("07697971965954677549", NOW)).toBeNull();
    expect(guidMintedSecond("0", NOW)).toBeNull();
  });

  it("2^64 and above are none; 2^64 - 1 is the last second a uint32 holds", () => {
    expect(guidMintedSecond("18446744073709551616", 2 ** 32 - 1)).toBeNull();
    expect(guidMintedSecond("99999999999999999999", NOW)).toBeNull();
    expect(guidMintedSecond("184467440737095516150", NOW)).toBeNull();
    expect(guidMintedSecond("18446744073709551615", 2 ** 32 - 1)).toBe(2 ** 32 - 1);
    expect(guidMintedSecond("18446744073709551615", NOW)).toBeNull();
  });
});
