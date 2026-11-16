import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_RULE } from "../constants/password.js";

describe("PASSWORD_RULE", () => {
  it("is the one wording every new-password field shows", () => {
    expect(PASSWORD_RULE).toBe(
      "8 to 64 characters, spaces allowed. Passwords found in known data breaches are refused.",
    );
  });

  it("states the lengths the api enforces", () => {
    expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([8, 64]);
    expect(PASSWORD_RULE).toContain(`${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`);
  });

  it("has no long dash", () => {
    expect(PASSWORD_RULE).not.toMatch(/[–—]/);
  });
});
