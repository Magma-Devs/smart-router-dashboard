import { describe, expect, it } from "vitest";
import { errorRetryDelayMs, isRateLimited, parseRetryAfter } from "../retry";
import { ApiError } from "../api-client";

/**
 * When a failed api read asks again.
 *
 * A 429 waits as long as the api says: asking sooner is refused again, spends
 * the same allowance, and is what keeps a crowded minute crowded. Every other
 * failure keeps SWR's own backoff.
 */

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("59", NOW)).toBe(59_000);
    expect(parseRetryAfter(" 0 ", NOW)).toBe(0);
  });

  it("reads an HTTP-date, as time from now", () => {
    expect(parseRetryAfter("Fri, 13 Nov 2026 12:00:30 GMT", NOW)).toBe(30_000);
    expect(parseRetryAfter("Fri, 13 Nov 2026 11:59:00 GMT", NOW)).toBe(0);
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["negative", "-5"],
    ["fractional", "1.5"],
    ["garbage", "soon"],
  ])("is null when %s", (_, value) => {
    expect(parseRetryAfter(value, NOW)).toBeNull();
  });
});

describe("isRateLimited", () => {
  it("is a 429, and nothing else", () => {
    expect(isRateLimited(new ApiError(429, "Rate limit exceeded"))).toBe(true);
    expect(isRateLimited(new ApiError(503, "down"))).toBe(false);
    expect(isRateLimited(new TypeError("Failed to fetch"))).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});

describe("errorRetryDelayMs", () => {
  const half = () => 0.5; // jitter at its midpoint: exactly the doubling

  it("waits out a 429 for as long as the api's Retry-After says", () => {
    const err = new ApiError(429, "Rate limit exceeded", undefined, NOW + 42_000);
    expect(errorRetryDelayMs(err, 1, 5000, NOW, half)).toBe(42_000);
    // Whatever the attempt: the api's time, not a doubling.
    expect(errorRetryDelayMs(err, 6, 5000, NOW, half)).toBe(42_000);
  });

  it("asks no sooner than a second after a 429, even one already past", () => {
    const err = new ApiError(429, "Rate limit exceeded", undefined, NOW - 5000);
    expect(errorRetryDelayMs(err, 1, 5000, NOW, half)).toBe(1000);
  });

  it("asks again within ten minutes, whatever the header said", () => {
    const err = new ApiError(429, "Rate limit exceeded", undefined, NOW + 86_400_000);
    expect(errorRetryDelayMs(err, 1, 5000, NOW, half)).toBe(600_000);
  });

  it("falls back to the backoff on a 429 that named no time", () => {
    expect(errorRetryDelayMs(new ApiError(429, "Rate limit exceeded"), 2, 5000, NOW, half)).toBe(20_000);
  });

  it("keeps SWR's backoff for every other failure", () => {
    const err = new ApiError(503, "auth database not ready");
    expect(errorRetryDelayMs(err, 1, 5000, NOW, half)).toBe(10_000);
    expect(errorRetryDelayMs(err, 3, 5000, NOW, half)).toBe(40_000);
    // Capped at 2^8 intervals.
    expect(errorRetryDelayMs(err, 20, 5000, NOW, half)).toBe(5000 * 256);
    // Jittered between half and one and a half times.
    expect(errorRetryDelayMs(err, 1, 5000, NOW, () => 0)).toBe(5000);
    expect(errorRetryDelayMs(new TypeError("Failed to fetch"), 1, 5000, NOW, () => 0.999)).toBe(10_000);
  });
});
