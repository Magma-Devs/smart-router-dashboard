import { test, expect, signInThroughUi, enrolledMember } from "../support/fixtures.js";
import { inviteMember } from "../support/api.js";

test("a suggested question sends on a click and leaves the composer empty", async ({
  page,
  operator,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const member = await enrolledMember(
    await inviteMember(operator.token, {
      email: "suggest.operator@example.test",
      name: "Suggest Operator",
      password: "suggest-operator-test-only-2207",
      role: "admin",
    }),
  );
  await signInThroughUi(page, member);
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  await page.getByRole("link", { name: "Ask your data" }).click();
  await page.waitForURL(/\/ask/);
  const suggestions = page.getByRole("list", { name: "Suggested questions" });
  await expect(suggestions.getByRole("button")).toHaveCount(4);
  await page.mouse.move(640, 300);
  await page.screenshot({ path: testInfo.outputPath("ask-empty.png"), animations: "disabled" });

  const question = "Which chains had failed requests today?";
  await suggestions.getByRole("button", { name: question }).click();
  // The click is the send: the question shows as the turn's heading at once.
  await expect(page.locator(".ask-question").filter({ hasText: question })).toBeVisible();
  await expect(suggestions).toHaveCount(0);
  await expect(page.getByLabel("Ask a question")).toHaveValue("");
  await expect(page.locator(".ask-processing")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ask-live.png"), animations: "disabled" });
  await expect(page.getByRole("article", { name: "Answer" }).locator(".ask-md table")).toBeVisible({
    timeout: 20_000,
  });
  await page.mouse.move(640, 400);
  await page.screenshot({ path: testInfo.outputPath("ask-answer.png"), animations: "disabled" });
});
