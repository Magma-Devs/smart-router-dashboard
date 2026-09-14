import { inviteMember, type SeededMember } from "../support/api.js";
import { enrolledMember, expect, signInThroughUi, test } from "../support/fixtures.js";

/**
 * Clearing somebody's authenticator from the team page — the lost-phone path.
 *
 * The api route has its own tests. This is about the three things around it: the
 * button appears only on a row that has something to clear, the confirmation
 * names the person before anything happens (an admin one row off is the failure
 * this guards against), and the row updates without a reload so the admin can
 * see it worked.
 */

let member: Required<SeededMember>;

test.beforeAll(async ({ operator }) => {
  member = await enrolledMember(
    await inviteMember(operator.token, {
      email: "e2e.lostphone@magmadevs.com",
      password: "lostphone-chose-this-7715",
      name: "Kito Alvarez",
    }),
  );
});

test("an admin clears a member's authenticator, and the row says so", async ({
  page,
  operator,
}) => {
  await signInThroughUi(page, operator);
  await page.goto("/team");

  const row = page.getByRole("row", { name: new RegExp(member.email) });
  await expect(row).toBeVisible();
  await expect(row.getByText("Yes", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: "Reset 2FA" }).click();

  // Naming them is the whole point of the confirmation.
  const modal = page.locator(".gw-modal");
  await expect(modal).toContainText("Reset two-factor authentication");
  await expect(modal).toContainText(member.name);
  await expect(modal).toContainText(member.email);
  await expect(modal).toContainText("They are signed out of every device immediately.");

  await modal.getByRole("button", { name: "Reset two-factor" }).click();

  await expect(modal).toHaveCount(0);
  await expect(row.getByText("No", { exact: true })).toBeVisible();
  // Nothing left to clear, so nothing offers to.
  await expect(row.getByRole("button", { name: "Reset 2FA" })).toHaveCount(0);
});

test("a member with no authenticator is not offered a reset", async ({ page, operator }) => {
  const unenrolled = await inviteMember(operator.token, {
    email: "e2e.noauthenticator@magmadevs.com",
    password: "noauth-chose-this-5520",
    name: "Pia Lindqvist",
  });

  await signInThroughUi(page, operator);
  await page.goto("/team");

  const row = page.getByRole("row", { name: new RegExp(unenrolled.email) });
  await expect(row.getByText("No", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Reset 2FA" })).toHaveCount(0);
  // The controls that do not depend on an authenticator are still there, so an
  // empty cell cannot pass for a row that failed to render.
  await expect(row.getByRole("button", { name: "Change role" })).toBeVisible();
});
