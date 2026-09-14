import { inviteMember, type SeededMember } from "../support/api.js";
import { expect, signInThroughUi, test } from "../support/fixtures.js";
import { Authenticator } from "../support/totp.js";

/**
 * The screen an invited member meets before they have an authenticator.
 *
 * Three things here exist only in a browser. The QR is markup the api renders
 * and the panel injects — an HTTP check can prove the response contains an
 * `<svg>`, not that anything was painted. The block is a component wrapping the
 * app rather than a route, so "the dashboard is shut" is a fact about what is
 * on screen. And it lifts by re-reading the account rather than by navigating,
 * which is the part most likely to regress quietly into a redirect.
 */

let member: SeededMember;

test.beforeAll(async ({ operator }) => {
  // Deliberately not enrolled: this spec is what happens before that.
  member = await inviteMember(operator.token, {
    email: "e2e.enrol@magmadevs.com",
    password: "enrol-chose-this-3310",
    name: "Rai Oduya",
  });
});

test("the dashboard stays shut until an authenticator is set up", async ({ page }) => {
  await signInThroughUi(page, member);

  // The password alone got a session — and a session is not the dashboard.
  await expect(
    page.getByRole("heading", { name: "Two-factor authentication is required" }),
  ).toBeVisible();
  // No sidebar full of links that would 403: the gate wraps the chrome.
  await expect(page.locator(".gw-app")).toHaveCount(0);

  // The QR is painted, not just delivered.
  const qr = page.locator('[aria-label="Authenticator QR code"] svg');
  await expect(qr).toBeVisible();
  const box = await qr.boundingBox();
  expect(box, "the QR has no layout box").not.toBeNull();
  expect(box!.width).toBeGreaterThan(100);
  expect(box!.height).toBeGreaterThan(100);

  // The key beside it is the same secret, and it is there for the person with
  // no camera in reach — so take it the way they would, off the screen.
  const printed = await page.locator("code.gw-mono").first().innerText();
  const authenticator = new Authenticator(printed.replace(/\s+/g, ""));

  // A marker that cannot survive a navigation. The gate is supposed to lift by
  // re-reading the account, not by reloading the page.
  await page.evaluate(() => {
    (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument = true;
  });

  await page.getByLabel("Code from the app").fill(await authenticator.next());
  await page.getByRole("button", { name: "Turn on two-factor" }).click();

  await expect(page.locator(".gw-app")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Two-factor authentication is required" }),
  ).toHaveCount(0);

  expect(
    await page.evaluate(
      () => (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument,
    ),
    "the gate lifted by reloading the page instead of re-reading the account",
  ).toBe(true);
});
