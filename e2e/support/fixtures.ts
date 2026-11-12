import { test as base, expect, type Page } from "@playwright/test";
import {
  createFirstAdmin,
  enrolAuthenticator,
  nextClientIp,
  signInApi,
  type SeededMember,
} from "./api.js";
import { closeDb, resetDeployment } from "./db.js";
import { OPERATOR } from "./env.js";
import type { Authenticator } from "./totp.js";

export interface Operator {
  email: string;
  password: string;
  userId: string;
  /** An admin Bearer, for seeding the accounts a spec needs. */
  token: string;
  authenticator: Authenticator;
}

/**
 * One deployment per worker, wound back to a fresh install.
 *
 * Every spec starts from an installation with exactly one account — the one the
 * installer made — and invites whatever else it needs under its own addresses.
 * Sharing that operator rather than re-running first-run setup per file keeps
 * the suite's `/auth/*` traffic well under the limiter, and means the enrolment
 * a spec is *not* testing was done the way the product does it.
 *
 * The operator is enrolled because an admin who is not cannot invite anybody:
 * `requireEnrolledToInvite` is what stops a stolen password from minting new
 * accounts, and it applies to the first admin too.
 */
export const test = base.extend<object, { operator: Operator }>({
  operator: [
    async ({}, use) => {
      await resetDeployment();
      await createFirstAdmin();
      const session = await signInApi(OPERATOR.email, OPERATOR.password);
      const authenticator = await enrolAuthenticator(session.token);
      await use({
        email: OPERATOR.email,
        password: OPERATOR.password,
        userId: session.userId,
        token: session.token,
        authenticator,
      });
      await closeDb();
    },
    { scope: "worker" },
  ],

  /**
   * A distinct client address per test.
   *
   * The api limits `/auth/*` to ten requests a minute per IP and derives the
   * address from `X-Forwarded-For` (`TRUST_PROXY` trusts one hop by default —
   * the shape it runs in behind our ingress). Without this every sign-in in the
   * suite shares one bucket and the limiter answers before the assertions do.
   *
   * Only the browser's own calls are covered. `/auth/2fa/verify` is made by the
   * Next server on the browser's behalf and arrives from that server's address
   * whatever this header says — which is why the suite runs serially and keeps
   * the number of full sign-ins small.
   */
  extraHTTPHeaders: async ({}, use) => {
    await use({ "x-forwarded-for": nextClientIp() });
  },
});

export { expect };

export interface UiAccount {
  email: string;
  password: string;
  authenticator?: Authenticator;
}

/** Both steps of the login form, ending on the dashboard. */
export async function signInThroughUi(page: Page, account: UiAccount): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  if (account.authenticator) {
    const code = page.getByLabel("Authenticator code");
    await expect(code).toBeVisible();
    await code.fill(await account.authenticator.next());
    await page.getByRole("button", { name: "Verify" }).click();
  }

  await page.waitForURL(/\/overview/);
}

/** A member with a working authenticator, seeded over HTTP. */
export async function enrolledMember(member: SeededMember): Promise<Required<SeededMember>> {
  const session = await signInApi(member.email, member.password);
  const authenticator = await enrolAuthenticator(session.token);
  return { ...member, authenticator };
}

/**
 * Record whether the dashboard's chrome is ever put on the page.
 *
 * Installed before the page loads, in every document it opens, and watching
 * insertions rather than polling the page: the chrome the enrolment gate used
 * to paint lasted only as long as the browser's own account read, which a
 * locator check after the fact can never see. Every inserted element counts,
 * including one already taken away again.
 */
export async function watchForDashboardChrome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __e2eChromeSeen?: boolean };
    w.__e2eChromeSeen = false;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.matches(".gw-app") || node.querySelector(".gw-app")) w.__e2eChromeSeen = true;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

/** Whether the current document has had the dashboard's chrome in it. */
export async function dashboardChromeSeen(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __e2eChromeSeen?: boolean }).__e2eChromeSeen === true,
  );
}
