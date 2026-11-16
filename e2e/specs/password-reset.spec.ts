import type { Page } from "@playwright/test";
import { apiCall, inviteMember, type SeededMember } from "../support/api.js";
import { expect, test } from "../support/fixtures.js";

/**
 * A reset link on screen, from the form to the page a spent link shows.
 *
 * Every dead link reads the same, used or expired or replaced, so the page must
 * not claim one of them. And a link spent while its form is open lands on that
 * same page when the form is submitted, not on a line of error text.
 */

let member: SeededMember;

test.beforeAll(async ({ operator }) => {
  member = await inviteMember(operator.token, {
    email: "e2e.reset@example.com",
    password: "reset-chose-this-3391",
    name: "Rina Okafor",
  });
});

/** An on-prem admin's reset link, as the Team page would show it. */
async function resetToken(adminToken: string): Promise<string> {
  const res = await apiCall<{ url?: string }>(
    "POST",
    `/api/team/members/${member.userId}/reset-link`,
    { token: adminToken },
  );
  const token = res.body?.url?.split("/reset/")[1];
  if (!token) throw new Error(`reset link: HTTP ${res.status} ${res.text}`);
  return token;
}

async function choosePassword(page: Page, password: string) {
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Repeat password").fill(password);
  await page.getByRole("button", { name: "Save password" }).click();
}

test("a used link says it no longer works, without saying why", async ({ page, operator }) => {
  const token = await resetToken(operator.token);

  await page.goto(`/reset/${token}`);
  await choosePassword(page, "reset-chose-again-4410");
  await expect(page.getByText("Password changed", { exact: true })).toBeVisible();
  await expect(page.getByText("That includes")).toHaveCount(0);

  await page.goto(`/reset/${token}`);
  await expect(page.getByText("This link no longer works", { exact: true })).toBeVisible();
  await expect(page.getByText(/It may have been used, replaced or expired\./)).toBeVisible();
  await expect(page.getByText("has expired")).toHaveCount(0);
});

test("a link spent while its form is open lands on the same page", async ({ page, operator }) => {
  const token = await resetToken(operator.token);
  await page.goto(`/reset/${token}`);
  await expect(page.getByLabel("New password")).toBeVisible();

  const spent = await apiCall("POST", "/auth/password/reset", {
    body: { token, password: "spent-elsewhere-5512" },
  });
  expect(spent.status).toBe(200);

  await choosePassword(page, "reset-chose-later-6623");
  await expect(page.getByText("This link no longer works", { exact: true })).toBeVisible();
});
