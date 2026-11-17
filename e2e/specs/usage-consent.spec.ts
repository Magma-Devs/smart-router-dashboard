import type { Page, Request } from "@playwright/test";
import { expect, signInThroughUi, test } from "../support/fixtures.js";

/**
 * The consent bar for usage data (MAG-5373).
 *
 * The unit tests hold the rule: nothing is recorded or sent before an
 * acceptance. What only a browser shows is the bar itself: that a signed-in
 * person is asked where the deployment sends usage data, that the page behind
 * it sends nothing while the bar is up, that each button does what it says,
 * and that the Account page changes the answer afterwards.
 *
 * The suite's stack has usage data off, so the api's two usage routes are
 * answered here: the switch says on, and every batch the page posts is kept.
 */

async function withUsageOn(page: Page): Promise<Request[]> {
  const batches: Request[] = [];
  await page.route("**/api/usage/config", (route) => route.fulfill({ json: { enabled: true } }));
  await page.route("**/api/usage", (route) => {
    batches.push(route.request());
    return route.fulfill({ status: 202, json: { accepted: 1 } });
  });
  return batches;
}

const names = (batches: Request[]) =>
  batches.flatMap((b) => (b.postDataJSON() as { events: { name: string }[] }).events.map((e) => e.name));

/** Longer than the page's send interval (10 s): a batch due would have gone. */
const SEND_WINDOW_MS = 12_000;

test("a signed-in person is asked, and nothing is sent until they accept", async ({ page, operator }) => {
  const batches = await withUsageOn(page);
  await signInThroughUi(page, operator);

  const bar = page.getByRole("region", { name: "Cookies and usage data" });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("Mixpanel, a third-party analytics service");
  await expect(bar.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "https://magmadevs.com/privacy");
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/consent-bar.png` });

  // The page behind the bar is in use, and sends nothing.
  await page.getByRole("link", { name: "Account" }).first().click();
  await page.waitForTimeout(SEND_WINDOW_MS);
  expect(batches, "usage data was sent before an acceptance").toHaveLength(0);
  expect(await page.evaluate(() => [localStorage.getItem("sr:usage-consent"), sessionStorage.getItem("sr:visit")])).toEqual([null, null]);

  await bar.getByRole("button", { name: "Accept" }).click();
  await expect(bar).toBeHidden();
  await expect.poll(() => names(batches), { timeout: SEND_WINDOW_MS + 5_000 }).toContain("page_view");
  expect(names(batches)[0]).toBe("visit_start");
  expect(await page.evaluate(() => localStorage.getItem("sr:usage-consent"))).toBe("accepted");

  // The answer holds over a reload: no bar, and the page sends.
  const before = batches.length;
  await page.reload();
  await expect(page.getByRole("button", { name: "Stop sending" })).toBeVisible();
  await expect(bar).toBeHidden();
  await expect.poll(() => batches.length, { timeout: SEND_WINDOW_MS + 5_000 }).toBeGreaterThan(before);
  if (process.env.E2E_SHOTS) {
    await page.getByRole("button", { name: "Stop sending" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.E2E_SHOTS}/account-usage.png` });
  }

  // The Account page takes it back.
  await page.getByRole("button", { name: "Stop sending" }).click();
  await expect(page.getByRole("button", { name: "Send usage data" })).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem("sr:usage-consent"), sessionStorage.getItem("sr:visit")])).toEqual(["rejected", null]);
  const after = batches.length;
  await page.waitForTimeout(SEND_WINDOW_MS);
  expect(batches, "usage data was sent after it was switched off").toHaveLength(after);
});

test("rejecting sends nothing and is not asked again; the X only puts the question off", async ({ page, operator }) => {
  const batches = await withUsageOn(page);
  await signInThroughUi(page, operator);
  const bar = page.getByRole("region", { name: "Cookies and usage data" });

  await bar.getByRole("button", { name: "Decide later" }).click();
  await expect(bar).toBeHidden();
  await page.reload();
  await expect(bar).toBeVisible();

  await bar.getByRole("button", { name: "Reject non-essential" }).click();
  await expect(bar).toBeHidden();
  await page.reload();
  await expect(page.locator(".gw-app")).toBeVisible();
  await expect(bar).toBeHidden();
  await page.waitForTimeout(SEND_WINDOW_MS);
  expect(batches).toHaveLength(0);
});

test("where the deployment sends no usage data there is no bar", async ({ page, operator }) => {
  await signInThroughUi(page, operator);
  await expect(page.locator(".gw-app")).toBeVisible();
  await expect(page.getByRole("region", { name: "Cookies and usage data" })).toBeHidden();
});
