import { inviteMember, type SeededMember } from "../support/api.js";
import { ageIntoGracePeriod } from "../support/db.js";
import { expect, signInThroughUi, test } from "../support/fixtures.js";

/**
 * The countdown the one account with a grace period carries in the header.
 *
 * The api reports `daysLeft` and the unit tests check the arithmetic at both
 * boundaries. What is only true on screen is that it is rendered at all — it is
 * a permanent strip rather than a dismissible banner, precisely because a
 * dismissible one is dismissed on day one — and that it changes colour in the
 * last week, which is the only signal that the thing it counts down to is near.
 *
 * The row is aged in the database because there is no other way to reach day
 * 25: the grace period is thirty real days from a real first sign-in.
 */

let member: SeededMember;

test.beforeAll(async ({ operator }) => {
  member = await inviteMember(operator.token, {
    email: "e2e.grace@magmadevs.com",
    password: "grace-chose-this-8802",
    name: "Nia Berhane",
  });
  // Set before the first sign-in on purpose: `recordSignIn` stamps
  // `first_signin_at` only when it is null, so a backdated value survives.
  await ageIntoGracePeriod(member.email, 2);
});

/** What the browser actually paints, as `rgb(r, g, b)`. */
async function paintedColour(page: import("@playwright/test").Page, selector: string) {
  return page.locator(selector).evaluate((el) => getComputedStyle(el).color);
}

function channels(rgb: string): [number, number, number] {
  const parts = rgb
    .match(/\d+(\.\d+)?/g)
    ?.slice(0, 3)
    .map(Number);
  if (!parts || parts.length !== 3) throw new Error(`not an rgb colour: ${rgb}`);
  return [parts[0]!, parts[1]!, parts[2]!];
}

test("the header counts the days down and turns red in the last week", async ({ page }) => {
  await signInThroughUi(page, member);

  const pill = page.getByRole("link", { name: /Set up 2FA/ });
  await expect(pill).toHaveText("Set up 2FA — 28 days left");
  const calm = await paintedColour(page, "a.pill");

  // Twenty-three days later.
  await ageIntoGracePeriod(member.email, 25);
  await page.reload();

  await expect(pill).toHaveText("Set up 2FA — 5 days left");
  const urgent = await paintedColour(page, "a.pill");

  expect(urgent, "the last week looks the same as the first").not.toBe(calm);

  // Asserted as "red", not as a hex: the token behind it is allowed to change,
  // the fact that a deadline inside a week reads as one is not.
  const [r, g, b] = channels(urgent);
  expect(r).toBeGreaterThan(g + 60);
  expect(r).toBeGreaterThan(b + 60);
});
