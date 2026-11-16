import { inviteMember, type SeededMember } from "../support/api.js";
import { enrolledMember, expect, signInThroughUi, test } from "../support/fixtures.js";

/**
 * Clearing somebody's authenticator from the team page — the lost-phone path.
 *
 * The api route has its own tests. This is about the things around it: the
 * row's menu offers it only where there is something to clear, the
 * confirmation names the person before anything happens (an admin one row off
 * is the failure this guards against), and the row updates without a reload,
 * with a confirmation, so the admin can see it worked.
 */

let member: Required<SeededMember>;

test.beforeAll(async ({ operator }) => {
  member = await enrolledMember(
    await inviteMember(operator.token, {
      email: "e2e.lostphone@example.com",
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

  await row.getByRole("button", { name: `Actions for ${member.name}` }).click();
  await page.getByRole("menuitem", { name: "Reset 2FA" }).click();

  // Naming them is the whole point of the confirmation.
  const modal = page.locator(".gw-modal");
  await expect(modal).toContainText("Reset 2FA");
  await expect(modal).toContainText(member.name);
  await expect(modal).toContainText(member.email);
  await expect(modal).toContainText("They are signed out of every device immediately.");

  await modal.getByRole("button", { name: "Reset 2FA" }).click();

  await expect(modal).toHaveCount(0);
  await expect(row.getByText("Not set up", { exact: true })).toBeVisible();
  // The page has other status regions (the top bar's health), so find ours by its words.
  await expect(
    page.getByRole("status").filter({ hasText: `2FA reset for ${member.name}.` }),
  ).toBeVisible();
  // Nothing left to clear, so the menu item no longer acts.
  await row.getByRole("button", { name: `Actions for ${member.name}` }).click();
  await expect(page.getByRole("menuitem", { name: "Reset 2FA" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("a member with no authenticator is not offered a reset", async ({ page, operator }) => {
  const unenrolled = await inviteMember(operator.token, {
    email: "e2e.noauthenticator@example.com",
    password: "noauth-chose-this-5520",
    name: "Pia Lindqvist",
  });

  await signInThroughUi(page, operator);
  await page.goto("/team");

  const row = page.getByRole("row", { name: new RegExp(unenrolled.email) });
  await expect(row.getByText("Not set up", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: `Actions for ${unenrolled.name}` }).click();
  await expect(page.getByRole("menuitem", { name: "Reset 2FA" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  // The actions that do not depend on an authenticator still act, so a
  // disabled item cannot pass for a menu that failed to render.
  await expect(page.getByRole("menuitem", { name: "Change role" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});
