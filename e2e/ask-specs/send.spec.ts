import { test, expect, signInThroughUi } from "../support/fixtures.js";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test("Send paints immediately and stays continuous across slow creation, acceptance and transcript reads", async ({
  page,
  operator,
}, testInfo) => {
  await signInThroughUi(page, operator);
  await page.goto("/ask");
  const composer = page.getByLabel("Ask a question");
  await expect(composer).toBeEnabled();
  const creation = gate();
  const acceptance = gate();
  const transcript = gate();
  await page.route("**/api/ask/chats", async (route) => {
    if (route.request().method() === "POST") await creation.wait;
    await route.continue();
  });
  await page.route("**/api/ask/chats/*/runs", async (route) => {
    await acceptance.wait;
    await route.continue();
  });
  await page.route(/\/api\/ask\/chats\/[^/?]+$/, async (route) => {
    if (route.request().method() === "GET") await transcript.wait;
    await route.continue();
  });
  const question = "Immediate question with slow delivery";
  const bubble = page.locator(".ask-question p").filter({ hasText: question });
  const posted = () =>
    page.waitForRequest((r) => r.method() === "POST" && /\/chats\/[^/]+\/runs$/.test(r.url()));
  try {
    await composer.fill(question);
    await composer.press("Enter");
    // The server cannot even create the chat yet: these assertions prove the
    // first visible feedback does not wait for any server response.
    await expect(bubble).toHaveCount(1);
    await expect(bubble).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(page.locator(".ask-processing")).toContainText("Sending…");
    await page.screenshot({ path: testInfo.outputPath("ask-sending-immediately.png") });
    await page.evaluate((text) => {
      const counts: number[] = [];
      const observer = new MutationObserver(() => {
        counts.push(
          [...document.querySelectorAll(".ask-question p")].filter((p) => p.textContent === text)
            .length,
        );
      });
      observer.observe(document.querySelector(".ask-page")!, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      (
        window as unknown as { sendContinuity: { counts: number[]; observer: MutationObserver } }
      ).sendContinuity = { counts, observer };
    }, question);
    const sent = posted();
    creation.release();
    const request = await sent;
    await page.waitForURL(/\/ask\?chat=/);
    await expect(bubble).toHaveCount(1);
    await expect(page.locator(".ask-processing")).toContainText("Sending…");
    acceptance.release();
    expect((await request.response())?.status()).toBe(200);
    // Acceptance and the transcript are separate HTTP responses. The saved
    // question must not disappear in the interval between them.
    await expect(page.locator(".ask-processing")).toContainText("Processing…");
    await expect(bubble).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("ask-accepted-awaiting-transcript.png") });
    transcript.release();
    await expect(page.getByRole("article", { name: "Answer" })).toHaveCount(1);
    await expect(bubble).toHaveCount(1);
    await expect(composer).toBeFocused();
    const counts = await page.evaluate(() => {
      const value = (
        window as unknown as { sendContinuity: { counts: number[]; observer: MutationObserver } }
      ).sendContinuity;
      value.observer.disconnect();
      return value.counts;
    });
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((count) => count === 1)).toBe(true);

    // Identical follow-ups are separate turns, never deduplicated by text.
    const followup = gate();
    await page.unroute("**/api/ask/chats/*/runs");
    await page.route("**/api/ask/chats/*/runs", async (route) => {
      await followup.wait;
      await route.continue();
    });
    try {
      await composer.fill(question);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(bubble).toHaveCount(2);
      await expect(composer).toHaveValue("");
      await expect(page.locator(".ask-processing")).toContainText("Sending…");
    } finally {
      followup.release();
    }
    await expect(page.getByRole("article", { name: "Answer" })).toHaveCount(2);
    await expect(bubble).toHaveCount(2);
  } finally {
    creation.release();
    acceptance.release();
    transcript.release();
  }
});

test("failed delivery restores the draft and retrying a lost acceptance response reuses the admitted run", async ({
  page,
  operator,
}) => {
  await signInThroughUi(page, operator);
  await page.goto("/ask");
  const composer = page.getByLabel("Ask a question");
  const requests: Array<{ idempotencyKey: string }> = [];
  let attempt = 0;
  await page.route("**/api/ask/chats/*/runs", async (route) => {
    requests.push(route.request().postDataJSON());
    attempt++;
    if (attempt === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unavailable" }),
      });
    } else if (attempt === 2) {
      // The actual API admits the run; only its response is lost.
      expect((await route.fetch()).status()).toBe(200);
      await route.abort("failed");
    } else await route.continue();
  });
  const question = "Retry this same question safely";
  await composer.fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue(question);
  await expect(page.locator(".ask-notice[role=alert]")).toContainText(
    "Your question is still here",
  );
  await expect(composer).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue(question);
  await expect(page.getByRole("article", { name: "Answer" })).toHaveCount(1);
  await expect(composer).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(composer).toBeEnabled();
  await expect(page.locator(".ask-processing")).toHaveCount(0);
  await expect(page.locator(".ask-question")).toHaveCount(1);
  await expect(page.getByRole("article", { name: "Answer" })).toHaveCount(1);
  expect(requests).toHaveLength(3);
  expect(new Set(requests.map((r) => r.idempotencyKey)).size).toBe(1);
});
