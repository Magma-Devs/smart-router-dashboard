import { test, expect, signInThroughUi, enrolledMember } from "../support/fixtures.js";
import { inviteMember } from "../support/api.js";

test("the streamed reply stays on screen until the saved answer replaces it", async ({
  page,
  operator,
}) => {
  await page.addInitScript(() => {
    // Sampled every frame: once a reply has streamed in, a frame with neither
    // the reply nor the saved answer is a blank the reader sees.
    const state = { seen: false, blankFrames: 0 };
    (window as unknown as { __handoff: typeof state }).__handoff = state;
    const tick = () => {
      const streaming = document.querySelector('article[aria-label="Reply in progress"]');
      const answer = document.querySelector('article[aria-label="Answer"]');
      if (streaming) state.seen = true;
      else if (state.seen && !answer) state.blankFrames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const member = await enrolledMember(
    await inviteMember(operator.token, {
      email: "handoff.operator@example.test",
      name: "Handoff Operator",
      password: "handoff-operator-test-only-7731",
      role: "admin",
    }),
  );
  await signInThroughUi(page, member);
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  // A transcript read slower than the run's own polls, as on a distant network.
  await page.route(/\/api\/ask\/chats\/[^/?]+(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") await new Promise((done) => setTimeout(done, 1200));
    await route.continue();
  });
  await page.getByRole("link", { name: "Ask your data" }).click();
  await page.waitForURL(/\/ask/);
  await page.getByLabel("Ask a question").fill("Which chains had failed requests today?");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByRole("article", { name: "Reply in progress" })).toBeVisible({
    timeout: 15_000,
  });
  const answer = page.getByRole("article", { name: "Answer" });
  await expect(answer.locator(".ask-md table")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("article", { name: "Reply in progress" })).toHaveCount(0);
  const handoff = await page.evaluate(
    () => (window as unknown as { __handoff: { seen: boolean; blankFrames: number } }).__handoff,
  );
  expect(handoff.seen).toBe(true);
  expect(handoff.blankFrames).toBe(0);
});
