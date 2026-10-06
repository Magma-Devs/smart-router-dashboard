import { afterEach, describe, expect, it, vi } from "vitest";
import { newUiEnabled } from "../new-ui";

describe("newUiEnabled (DASHBOARD_NEW_UI)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when the variable is unset: an upgrade keeps the 0.27 screens", () => {
    expect(newUiEnabled({})).toBe(false);
  });

  it("is on for true, in any case and with stray whitespace", () => {
    for (const v of ["true", "TRUE", "True", " true\n"]) expect(newUiEnabled({ DASHBOARD_NEW_UI: v })).toBe(true);
  });

  it("is off for anything else, empty included (compose passes `${DASHBOARD_NEW_UI:-}`)", () => {
    for (const v of ["", "false", "0", "1", "yes", "on", "enabled"]) {
      expect(newUiEnabled({ DASHBOARD_NEW_UI: v })).toBe(false);
    }
  });

  it("reads the live process env by default, so the layout sees a container's value per request", () => {
    vi.stubEnv("DASHBOARD_NEW_UI", "true");
    expect(newUiEnabled()).toBe(true);
    vi.stubEnv("DASHBOARD_NEW_UI", "false");
    expect(newUiEnabled()).toBe(false);
  });
});
