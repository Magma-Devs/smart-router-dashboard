import { inviteMember, type SeededMember } from "../support/api.js";
import { enrolledMember, expect, test } from "../support/fixtures.js";

/**
 * The login form's two steps.
 *
 * The api-side contract — a verified password opens no session — is asserted in
 * `apps/api/src/__tests__` and again live in `scripts/sanity-two-factor.mjs`.
 * What only a browser can show is the form's half of it: that the code field
 * appears after the password and not before, that a wrong code costs the whole
 * sign-in rather than just the code, and that the wording never says which
 * factor failed.
 */

let member: Required<SeededMember>;

test.beforeAll(async ({ operator }) => {
  member = await enrolledMember(
    await inviteMember(operator.token, {
      email: "e2e.signin@magmadevs.com",
      password: "signin-chose-this-9021",
      name: "Sam Ngata",
    }),
  );
});

test("the code is asked for only after the password is accepted", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Authenticator code")).toHaveCount(0);

  await page.getByLabel("Email").fill(member.email);
  await page.getByLabel("Password").fill(member.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByLabel("Authenticator code")).toBeVisible();
  await expect(page.getByText("Enter your authenticator code")).toBeVisible();
  // The password field is gone, not merely hidden — the first step is over.
  await expect(page.getByLabel("Password")).toHaveCount(0);

  // And still nothing has been opened: a correct password is not a session.
  expect(new URL(page.url()).pathname).toBe("/login");
});

test("a wrong code costs the whole sign-in, and the right one gets through", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(member.email);
  await page.getByLabel("Password").fill(member.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByLabel("Authenticator code").fill(member.authenticator.wrong());
  await page.getByRole("button", { name: "Verify" }).click();

  // Back to step one. The challenge is spent whether or not the code was right,
  // so there is nothing left to try a second code against — and the form says
  // so by putting the password back rather than leaving the code field up.
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByLabel("Authenticator code")).toHaveCount(0);
  await expect(page.getByLabel("Password")).toHaveValue("");

  // One message for both steps: it must not reveal that the password was right.
  // Scoped to the card because Next's own route announcer is also `role=alert`.
  await expect(page.locator(".gw-card").getByRole("alert")).toHaveText(
    "Invalid email or password.",
  );

  // Same credentials, a code the phone would actually be showing.
  await page.getByLabel("Password").fill(member.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Authenticator code").fill(await member.authenticator.next());
  await page.getByRole("button", { name: "Verify" }).click();

  await page.waitForURL(/\/overview/);
  await expect(page.locator(".gw-app")).toBeVisible();
});
