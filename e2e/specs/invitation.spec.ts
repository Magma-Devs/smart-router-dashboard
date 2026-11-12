import type { Page } from "@playwright/test";
import { createInvitation } from "../support/api.js";
import { expect, test } from "../support/fixtures.js";

/**
 * Redeeming an invitation on screen, from the password to the first page.
 *
 * One click starts three things that each take a moment: the api creates the
 * account, Auth.js signs it in, and the browser loads the dashboard. What only
 * a browser can show is that the form says so the whole way through: the button
 * turns into a spinner and stays one, rather than returning to "Accept
 * invitation" between the answer and the next page and reading as a request
 * that was lost.
 */

const INVITEE = {
  email: "e2e.invite@example.com",
  password: "invite-chose-this-5521",
  name: "Ade Kowalczyk",
};

let token: string;

test.beforeAll(async ({ operator }) => {
  token = await createInvitation(operator.token, INVITEE.email);
});

/**
 * Hold one kind of POST until the test lets it go, so a state that normally
 * lasts a few milliseconds stays on screen long enough to be looked at.
 */
async function hold(page: Page, url: RegExp) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  await page.route(url, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    arrived();
    await released;
    await route.continue();
  });
  return { reached, release };
}

test("the form shows it is working from the click until the next page", async ({ page }) => {
  const accept = await hold(page, /\/auth\/invite\/accept$/);
  const signIn = await hold(page, /\/api\/auth\/callback\/credentials/);

  await page.goto(`/invite/${token}`);
  await page.getByLabel("Your name").fill(INVITEE.name);
  await page.getByLabel("Password", { exact: true }).fill(INVITEE.password);
  await page.getByLabel("Repeat password").fill(INVITEE.password);
  await page.getByRole("button", { name: "Accept invitation" }).click();

  // The account is being created.
  await accept.reached;
  const creating = page.getByRole("button", { name: "Joining…" });
  await expect(creating).toBeDisabled();
  await expect(creating).toHaveAttribute("aria-busy", "true");
  await expect(creating.locator("svg.gw-spin")).toBeVisible();
  // What was typed is what is being sent.
  for (const field of ["Your name", "Repeat password"]) {
    await expect(page.getByLabel(field)).toHaveAttribute("readonly", "");
  }
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("readonly", "");

  // The account exists and the answer is back; the sign-in is still running.
  // This is the gap where the button used to read as idle.
  accept.release();
  await signIn.reached;
  const signingIn = page.getByRole("button", { name: "Signing in…" });
  await expect(signingIn).toBeDisabled();
  await expect(signingIn).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);

  signIn.release();
  await page.waitForURL(/\/overview/);
  // A new member has no authenticator and no grace period, so the dashboard
  // is shut until they set one up.
  await expect(
    page.getByRole("heading", { name: "Two-factor authentication is required" }),
  ).toBeVisible();
});
