import { createDb } from "@sr/db";
import { test, expect, signInThroughUi } from "../support/fixtures.js";
import { DATABASE_URL } from "../support/env.js";

test("a clock question gets a short persisted reply with no external work", async ({
  page,
  operator,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("sr:theme", "light"));
  await signInThroughUi(page, operator);
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  await page.getByRole("link", { name: "AI investigation" }).click();
  await page.getByLabel("Ask a question").fill("what is the date today?");
  const started = Date.now();
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/ask\/chats\/[^/]+\/runs$/.test(response.url()),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const run = (await (await submitted).json()) as { id: string };
  const answer = page.getByRole("article", { name: "Answer" });
  await expect(answer.locator(".ask-summary")).toContainText(/^Today is .+ \(UTC\)\.$/);
  const elapsedMs = Date.now() - started;
  expect(elapsedMs).toBeLessThan(10_000);
  testInfo.annotations.push({ type: "local-clock-response-ms", description: String(elapsedMs) });
  await expect(answer.locator(".ask-sections li")).toHaveCount(0);
  await expect(answer.locator(".ask-evidence")).toHaveCount(0);
  const summary = await answer.locator(".ask-summary").textContent();
  await page.screenshot({
    path: testInfo.outputPath("ask-clock-desktop.png"),
    animations: "disabled",
  });

  const handle = createDb(DATABASE_URL);
  try {
    const [totals] = await handle.sql`
      select count(*)::int as steps,
        coalesce(sum(charged_micro_usd), 0)::text as spent,
        coalesce(sum(reserved_micro_usd), 0)::text as reserved
      from ask_model_steps where run_id = ${run.id}
    `;
    expect(totals).toEqual({ steps: 0, spent: "0", reserved: "0" });
  } finally {
    await handle.sql.end();
  }
  await page.waitForURL(/\/ask\?chat=/);
  await page.reload();
  await expect(page.getByRole("article", { name: "Answer" }).locator(".ask-summary")).toHaveText(
    summary!,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  await page.screenshot({
    path: testInfo.outputPath("ask-clock-mobile.png"),
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});
