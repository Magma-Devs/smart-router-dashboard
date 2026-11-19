import { test, expect, signInThroughUi, enrolledMember } from "../support/fixtures.js";
import { inviteMember } from "../support/api.js";

test("a readable conversation keeps questions, answers and composer usable on desktop and phone", async ({
  page,
  operator,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("sr:theme", "light"));
  const member = await enrolledMember(
    await inviteMember(operator.token, {
      email: "demo.operator@example.test",
      name: "Demo Operator",
      password: "demo-operator-test-only-8294",
      role: "admin",
    }),
  );
  await signInThroughUi(page, member);
  // Suppress only Next's development overlay, which is not product UI.
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  const shot = (name: string) =>
    page.screenshot({ path: testInfo.outputPath(name), animations: "disabled" });
  await page.getByRole("link", { name: "AI investigation" }).click();
  await page.waitForURL(/\/ask/);
  await expect(page.getByText("What’s happening with your router?")).toBeVisible();
  // One name on the page: the top bar's. No second title, no second menu.
  await expect(page.getByRole("heading", { name: "AI investigation" })).toHaveCount(0);
  await expect(page.locator(".gw-side")).toBeVisible();
  await page.mouse.move(700, 300);
  await shot("ask-empty-desktop.png");

  const first = "How many monitoring targets are up right now?";
  const followUp = "Does that mean every RPC request is healthy?";
  await page.getByLabel("Ask a question").fill(first);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Three monitoring targets are up right now.")).toBeVisible();
  // A short answer must not scroll its own question off screen.
  await expect(page.locator(".ask-question").getByText(first)).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel("Ask a question")).toBeInViewport({ ratio: 1 });
  expect((await page.locator(".ask-thread").boundingBox())!.width).toBeLessThanOrEqual(740);
  await page.getByLabel("Ask a question").fill(followUp);
  await page.mouse.move(700, 300);
  await shot("ask-conversation-desktop.png");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.mouse.move(700, 300);
  await shot("ask-conversation-desktop-dark.png");
  await page.getByRole("button", { name: "Toggle theme" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Ask a question")).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      page
        .getByLabel("Ask a question")
        .evaluate((field) => field.scrollHeight <= field.clientHeight + 1),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot("ask-mobile.png");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByLabel("Search your chats")).toBeVisible();
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("article", { name: "Answer" })).toHaveCount(2);
  await expect(
    page.getByText("No — a target being up doesn’t guarantee healthy RPC traffic."),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1200 });
  await expect(page.locator(".ask-question").getByText(followUp)).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel("Ask a question")).toBeInViewport({ ratio: 1 });
  await page.locator(".ask-transcript").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator(".ask-question").getByText(first)).toBeInViewport({ ratio: 1 });
  await page.mouse.move(700, 300);
  await shot("ask-two-answers-desktop.png");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".ask-history-list li button")).toHaveCount(1);
  await shot("ask-history-desktop.png");
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByLabel("Ask a question").fill("A longer follow-up\n".repeat(12));
  expect(
    await page.getByLabel("Ask a question").evaluate((field) => field.clientHeight),
  ).toBeLessThanOrEqual(180);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport({
    ratio: 1,
  });
  // While an answer runs, Stop takes the send button's place in the input box.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("Ask a question").fill("SLOW_FIXTURE what changed in the last hour?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".ask-input").getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.locator(".ask-processing").getByRole("button")).toHaveCount(0);
  await page.mouse.move(700, 300);
  await shot("ask-running-desktop.png");
  await page.locator(".ask-input").getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("The question was stopped.", { exact: true })).toBeVisible();
  // The off switch is the Team page's.
  await page.getByRole("link", { name: "Team", exact: true }).click();
  await expect(page.getByText("On for everyone")).toBeVisible();
  await shot("ask-team-switch.png");
  expect(errors).toEqual([]);
});
