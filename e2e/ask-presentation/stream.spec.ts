import { test, expect, signInThroughUi, enrolledMember } from "../support/fixtures.js";
import { inviteMember } from "../support/api.js";

test("an answer streams in as the model writes it, then settles as Markdown with its sources", async ({
  page,
  operator,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.addInitScript(() => localStorage.setItem("sr:theme", "dark"));
  const member = await enrolledMember(
    await inviteMember(operator.token, {
      email: "stream.operator@example.test",
      name: "Stream Operator",
      password: "stream-operator-test-only-5512",
      role: "admin",
    }),
  );
  await signInThroughUi(page, member);
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  await page.getByRole("link", { name: "Ask your data" }).click();
  await page.waitForURL(/\/ask/);
  await page.getByLabel("Ask a question").fill("Which chains had failed requests today?");
  const drafts: string[] = [];
  let sent = Date.now();
  page.on("response", async (response) => {
    if (response.status() === 429 || response.status() >= 500)
      drafts.push(`${Date.now() - sent} ${response.status()} ${new URL(response.url()).pathname}`);
    if (/\/api\/ask\/runs\/[^/]+\/draft$/.test(response.url()))
      drafts.push(
        `${Date.now() - sent} ${response.status()} ${(await response.text().catch(() => "")).slice(0, 60)}`,
      );
  });
  sent = Date.now();
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // The reply shows part of its text before the answer is saved.
  testInfo.annotations.push({ type: "drafts", description: "" });
  const streaming = page.getByRole("article", { name: "Reply in progress" });
  await expect(streaming)
    .toContainText("Two chains had failed requests", { timeout: 15_000 })
    .catch((error) => {
      throw new Error(`${error}\nDRAFTS ${JSON.stringify(drafts)}`);
    });
  const partial = (await streaming.textContent()) ?? "";
  expect(partial.length).toBeLessThan(400);
  await expect(page.locator(".ask-status-text")).toHaveText(/…$/);
  await page.screenshot({ path: testInfo.outputPath("ask-streaming.png") });

  const answer = page.getByRole("article", { name: "Answer" });
  await expect(answer.locator(".ask-md table"))
    .toBeVisible({ timeout: 15_000 })
    .catch((error) => {
      throw new Error(`${error}\nDRAFTS ${JSON.stringify(drafts)}`);
    });
  await expect(streaming).toHaveCount(0);
  await expect(answer.locator(".ask-md strong").first()).toHaveText("Ethereum");
  await expect(answer.locator(".ask-md th")).toHaveText(["Chain", "Requests", "Failed", "Rate"]);
  await expect(answer.locator(".ask-evidence summary")).toContainText(/1 source/);
  await page.mouse.move(640, 400);
  await page.screenshot({ path: testInfo.outputPath("ask-answer.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(answer.locator(".ask-md table")).toBeVisible();
  // A wide table scrolls inside its frame; the page itself does not.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("ask-answer-phone.png") });
});
