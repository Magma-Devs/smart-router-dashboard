import { test, expect, signInThroughUi, enrolledMember } from "../support/fixtures.js";
import { inviteMember } from "../support/api.js";

test("a readable conversation keeps questions, answers and composer usable across chat views", async ({
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
  await page.getByRole("button", { name: "Ask your data" }).click();
  await page.getByRole("button", { name: "Open full chat" }).click();
  await page.waitForURL(/\/ask/);
  await expect(page.getByText("What’s happening with your router?")).toBeVisible();
  await page.getByRole("heading", { name: "Ask your data", exact: true }).click();
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
  await expect(page.locator(".gw-side")).toBeHidden();
  await expect(page.getByRole("link", { name: "Your account", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.getByLabel("Ask a question").fill(followUp);
  await page.getByRole("heading", { name: "Ask your data", exact: true }).click();
  await shot("ask-full-desktop.png");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await shot("ask-full-desktop-dark.png");
  await page.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Ask your data" });
  await expect(panel).toBeVisible();
  await expect(page.locator(".gw-side")).toBeVisible();
  await expect(panel.getByLabel("Ask a question")).toHaveValue(followUp);
  await panel.getByRole("heading", { name: "Ask your data" }).click();
  await shot("ask-panel-desktop.png");

  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = page.getByRole("dialog", { name: "Ask your data" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Ask a question")).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      dialog
        .getByLabel("Ask a question")
        .evaluate((field) => field.scrollHeight <= field.clientHeight + 1),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole("heading", { name: "Ask your data" }).click();
  await shot("ask-panel-mobile.png");
  await dialog.getByRole("button", { name: "History", exact: true }).click();
  await expect(dialog.getByLabel("Search your chats")).toBeVisible();
  await dialog.getByRole("button", { name: "← Back to chat", exact: true }).click();
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("article", { name: "Answer" })).toHaveCount(2);
  await expect(
    dialog.getByText("No — a target being up doesn’t guarantee healthy RPC traffic."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Open full chat" }).click();
  await page.waitForURL(/\/ask\?chat=/);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await expect(page.locator(".ask-question").getByText(followUp)).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel("Ask a question")).toBeInViewport({ ratio: 1 });
  await page.locator(".ask-transcript").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator(".ask-question").getByText(first)).toBeInViewport({ ratio: 1 });
  await page.getByRole("heading", { name: "Ask your data", exact: true }).click();
  await shot("ask-full-conversation.png");
  await page.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 720 });
  await dialog.getByLabel("Ask a question").fill("A longer follow-up\n".repeat(12));
  expect(
    await dialog.getByLabel("Ask a question").evaluate((field) => field.clientHeight),
  ).toBeLessThanOrEqual(180);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeInViewport({
    ratio: 1,
  });
  expect(errors).toEqual([]);
});
