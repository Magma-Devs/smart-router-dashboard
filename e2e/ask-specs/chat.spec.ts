import { test, expect, signInThroughUi, enrolledMember } from "../support/fixtures.js";
import { apiCall, inviteMember, nextClientIp } from "../support/api.js";
import { API_URL } from "../support/env.js";

test.beforeEach(async ({ context }) => {
  // Context options can be reused with the worker. Give each flow its own
  // ingress client address without changing the production rate limits.
  await context.setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
});

const openAsk = (page: import("@playwright/test").Page) =>
  page.getByRole("link", { name: "Ask your data" }).click();
const DAY_MS = 86_400_000;

test("a new chat covers the last day, and a follow-up keeps its scope over a time ending now", async ({
  page,
  operator,
}) => {
  const member = await enrolledMember(
    await inviteMember(operator.token, {
      email: "ask.router@example.test",
      name: "Router Reader",
      password: "router-chose-this-7821",
      role: "read_only",
    }),
  );
  await signInThroughUi(page, member);
  await page.goto("/upstreams");
  // One way in: the menu. No top-bar button, no shortcut.
  await expect(page.getByRole("button", { name: /Ask your data/ })).toHaveCount(0);
  await openAsk(page);
  await page.waitForURL(/\/ask$/);
  const runs = () =>
    page.waitForRequest(
      (request) =>
        request.method() === "POST" && /\/api\/ask\/chats\/[^/]+\/runs$/.test(request.url()),
    );
  const submission = runs();
  await page.getByLabel("Ask a question").fill("What do current metrics show?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const first = await submission;
  const sent = first.postDataJSON().context as { page: string; from: string; to: string };
  expect(Object.keys(sent).sort()).toEqual(["from", "page", "to"]);
  expect(sent.page).toBe("ask");
  expect(Date.parse(sent.to) - Date.parse(sent.from)).toBe(DAY_MS);
  expect((await first.response())?.status()).toBe(200);
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  await page.waitForURL(/\/ask\?chat=/);
  await expect(page.getByLabel("Ask a question")).toBeFocused();
  await page.reload();
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  const followUp = runs();
  await page.getByLabel("Ask a question").fill("And now?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const second = await followUp;
  const again = second.postDataJSON().context as { page: string; from: string; to: string };
  expect(again.page).toBe("ask");
  expect(Date.parse(again.to) - Date.parse(again.from)).toBe(DAY_MS);
  expect(Date.parse(again.to)).toBeGreaterThan(Date.parse(sent.to));
  expect((await second.response())?.status()).toBe(200);
  await expect(page.getByRole("article", { name: "Answer" })).toHaveCount(2);
});

test("the chat page keeps history, drafts, evidence, search and copy, away and back, and fits a phone", async ({
  page,
  context,
  operator,
  browser,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInThroughUi(page, operator);
  await openAsk(page);
  await page
    .getByLabel("Ask a question")
    .fill("PRIVATE_BROWSER_QUESTION What do current metrics show?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Processing…" })).toBeVisible();
  await page.waitForURL(/\/ask\?chat=/);
  const chatUrl = page.url();
  // The rest of the dashboard stays in use; the menu leads back to the same chat.
  await page.getByRole("link", { name: "Metrics", exact: true }).click();
  await page.waitForURL(/\/metrics/);
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await openAsk(page);
  await page.waitForURL(chatUrl);
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  await page
    .locator(".ask-evidence summary")
    .filter({ hasText: /\d+ sources?/ })
    .first()
    .click();
  await expect(page.locator(".ask-evidence").getByText("Metrics", { exact: true })).toBeVisible();
  await expect(page.locator(".ask-evidence")).not.toContainText("e2e-metrics");
  await expect(page.getByText("<script>window.__askUnsafe=true</script>")).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __askUnsafe?: boolean }).__askUnsafe),
  ).toBeUndefined();
  await page.getByRole("button", { name: "Copy answer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Source: Metrics");
  await page.getByLabel("Ask a question").fill("Unsent follow-up draft");
  await page.getByRole("link", { name: "Upstreams", exact: true }).click();
  await page.waitForURL(/\/upstreams/);
  await openAsk(page);
  await page.waitForURL(chatUrl);
  await expect(page.getByLabel("Ask a question")).toHaveValue("Unsent follow-up draft");
  await page.reload();
  await expect(
    page
      .locator(".ask-question")
      .getByText("PRIVATE_BROWSER_QUESTION What do current metrics show?", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  const searched = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/ask/chats/search") &&
      Boolean(request.postData()?.includes("PRIVATE_BROWSER_QUESTION")),
  );
  await page.getByLabel("Search your chats").fill("PRIVATE_BROWSER_QUESTION");
  expect(new URL((await searched).url()).search).toBe("");
  await expect(page.locator(".ask-history-list li button")).toHaveCount(1);
  await page.getByLabel("Search your chats").fill("definitely-no-such-chat");
  await expect(page.getByText("No chats match this search.")).toBeVisible();
  await page.getByLabel("Search your chats").fill("");
  await expect.poll(() => page.locator(".ask-history-list li button").count()).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("ask-history-desktop.png"), fullPage: false });
  await page.locator(".ask-history-list li button").first().click();
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByLabel("Ask a question")).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByLabel("Search your chats")).toBeVisible();
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("ask-mobile.png"), fullPage: false });
  const stored = await context.storageState();
  const freshContext = await browser.newContext({
    storageState: { cookies: stored.cookies, origins: [] },
    extraHTTPHeaders: { "x-forwarded-for": nextClientIp() },
  });
  try {
    const fresh = await freshContext.newPage();
    await fresh.goto(chatUrl);
    await expect(fresh.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  } finally {
    await freshContext.close();
  }
});

test("one active question spans tabs, Stop persists, and failed answers remain readable after reload", async ({
  page,
  context,
  operator,
}) => {
  await signInThroughUi(page, operator);
  await page.goto("/ask");
  await page.getByLabel("Ask a question").fill("SLOW_FIXTURE keep this question running");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Processing…" })).toBeVisible();
  const second = await context.newPage();
  await second.goto("/ask");
  await expect(second.getByLabel("Ask a question")).toBeDisabled();
  await expect(second.getByRole("button", { name: "View processing question" })).toBeVisible();
  await second.getByRole("button", { name: "View processing question" }).click();
  await second.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(second.getByText("The question was stopped.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("The question was stopped.", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "Answer" })).toHaveCount(0);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.getByLabel("Ask a question").fill("INVALID_FIXTURE invalid answer case");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText("The answer exceeded its limit. Please try a narrower question.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("The answer exceeded its limit. Please try a narrower question.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit and retry" }).click();
  await expect(page.getByLabel("Ask a question")).toHaveValue(
    "INVALID_FIXTURE invalid answer case",
  );
  await second.close();
});

test("personal history pages and a read-only member cannot open another person's chat", async ({
  page,
  operator,
}) => {
  await signInThroughUi(page, operator);
  await page.goto("/ask");
  await page.getByLabel("Ask a question").fill("OWNER_ONLY_BROWSER_MESSAGE");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  const privateUrl = page.url();
  for (let i = 0; i < 22; i++)
    expect(
      (await apiCall("POST", "/api/ask/chats", { token: operator.token, body: {} })).status,
    ).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".ask-history-list li button")).toHaveCount(20);
  await page.getByRole("button", { name: "Load more chats" }).click();
  await expect.poll(() => page.locator(".ask-history-list li button").count()).toBeGreaterThan(20);
  const member = await enrolledMember(
    await inviteMember(operator.token, {
      email: "ask.reader@example.test",
      name: "Ask Reader",
      password: "reader-chose-this-7821",
      role: "read_only",
    }),
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(/\/login$/);
  await signInThroughUi(page, member);
  await page.goto(privateUrl);
  await expect(page.getByText("This chat couldn’t be found", { exact: true })).toBeVisible();
  await expect(page.getByText("OWNER_ONLY_BROWSER_MESSAGE", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Start a new chat", exact: true }).click();
  await page.getByLabel("Ask a question").fill("Read-only member question");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  const health = await fetch(`${API_URL}/health`);
  expect(health.ok).toBe(true);
});

test("earlier messages load without duplicates or moving the existing reading position", async ({
  page,
  operator,
}) => {
  await signInThroughUi(page, operator);
  const created = await apiCall<{ id: string }>("POST", "/api/ask/chats", {
    token: operator.token,
    body: {},
  });
  expect(created.status).toBe(200);
  const chatId = created.body!.id;
  // Actual metered API/worker writes, with the synthetic provider boundary.
  // Twenty-six turns produce 52 messages, crossing the 50-message API page.
  for (let i = 0; i < 26; i++) {
    const submitted = await apiCall<{ id: string }>("POST", `/api/ask/chats/${chatId}/runs`, {
      token: operator.token,
      body: { idempotencyKey: crypto.randomUUID(), question: `PAGING_FIXTURE_${i}` },
    });
    expect(submitted.status).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await apiCall<{ status: string }>("GET", `/api/ask/runs/${submitted.body!.id}`, {
              token: operator.token,
            })
          ).body?.status,
        { timeout: 15_000, intervals: [100, 250] },
      )
      .toBe("succeeded");
  }
  await page.goto(`/ask?chat=${chatId}`);
  const questions = page.locator(".ask-question");
  await expect(questions).toHaveCount(25);
  await expect(questions.getByText("PAGING_FIXTURE_0", { exact: true })).toHaveCount(0);
  await page.locator(".ask-transcript").evaluate((element) => {
    element.scrollTop = 0;
  });
  const anchor = questions.getByText("PAGING_FIXTURE_1", { exact: true });
  const before = (await anchor.boundingBox())!.y;
  await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  await expect(questions).toHaveCount(26);
  await expect(page.getByRole("article", { name: "Answer" })).toHaveCount(26);
  await expect(questions.getByText("PAGING_FIXTURE_0", { exact: true })).toHaveCount(1);
  const after = (await anchor.boundingBox())!.y;
  expect(Math.abs(after - before)).toBeLessThan(8);
});

test("an admin turns Ask off for everyone, stopping a member's question, and back on", async ({
  page,
  operator,
  browser,
}) => {
  const member = await enrolledMember(
    await inviteMember(operator.token, {
      email: "ask.switch@example.test",
      name: "Switch Reader",
      password: "switch-chose-this-4417",
      role: "read_only",
    }),
  );
  const memberContext = await browser.newContext();
  await memberContext.setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
  const memberPage = await memberContext.newPage();
  try {
    await signInThroughUi(memberPage, member);
    await openAsk(memberPage);
    await memberPage.getByLabel("Ask a question").fill("SLOW_FIXTURE stopped by the switch");
    await memberPage.getByRole("button", { name: "Send", exact: true }).click();
    await expect(memberPage.getByRole("status").filter({ hasText: "Processing…" })).toBeVisible();
    // The switch is the Team page's, and only an admin's.
    await memberPage.getByRole("link", { name: "Team", exact: true }).click();
    await memberPage.waitForURL(/\/team/);
    await expect(memberPage.getByRole("heading", { name: "Team" })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "Turn off" })).toHaveCount(0);
    await openAsk(memberPage);

    await signInThroughUi(page, operator);
    await page.goto("/ask");
    await expect(page.getByRole("button", { name: "Turn off" })).toHaveCount(0);
    await page.goto("/team");
    await expect(page.getByText("On for everyone")).toBeVisible();
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Turn Ask off for everyone?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Turn off Ask" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByText("Off for everyone")).toBeVisible();
    await openAsk(page);
    await expect(page.getByText(/An admin turned Ask off for everyone/)).toBeVisible();
    await expect(page.getByLabel("Ask a question")).toBeDisabled();

    await expect(memberPage.getByText("The question was stopped.", { exact: true })).toBeVisible();
    await expect(memberPage.getByText(/An admin turned Ask off for everyone/)).toBeVisible();
    await expect(memberPage.getByRole("link", { name: "Turn it back on in Team" })).toHaveCount(0);
    await expect(memberPage.getByLabel("Ask a question")).toBeDisabled();

    await page.getByRole("link", { name: "Turn it back on in Team" }).click();
    await page.waitForURL(/\/team/);
    await page.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect(page.getByText("On for everyone")).toBeVisible();
    await openAsk(page);
    await expect(page.getByText(/An admin turned Ask off for everyone/)).toHaveCount(0);
    await expect(page.getByLabel("Ask a question")).toBeEnabled();
  } finally {
    // The suite shares one database: never leave Ask off for the flows after this one.
    await apiCall("POST", "/api/ask/switch", { token: operator.token, body: { off: false } });
    await memberContext.close();
  }
});

test("connection loss shows an unknown status, reconnects to the saved answer and never resubmits", async ({
  page,
  operator,
}) => {
  await signInThroughUi(page, operator);
  await openAsk(page);
  let submissions = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/ask\/chats\/[^/]+\/runs$/.test(request.url()))
      submissions++;
  });
  await page.getByLabel("Ask a question").fill("SLOW_FIXTURE check connection recovery");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Processing…" })).toBeVisible();
  await page.route("**/api/ask/runs/active", (route) => route.abort("failed"));
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting…" })).toBeVisible();
  await expect(
    page.getByText("Connection lost. Reconnecting to check your question’s saved status."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.unroute("**/api/ask/runs/active");
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting…" })).toHaveCount(0);
  expect(submissions).toBe(1);
});

test("reloading while a question runs resumes that run and saves exactly one answer", async ({
  page,
  operator,
}) => {
  await signInThroughUi(page, operator);
  await openAsk(page);
  let submissions = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/ask\/chats\/[^/]+\/runs$/.test(request.url()))
      submissions++;
  });
  await page.getByLabel("Ask a question").fill("SLOW_FIXTURE reload while processing");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/ask\?chat=/);
  await expect(page.getByRole("status").filter({ hasText: "Processing…" })).toBeVisible();
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByRole("article", { name: "Answer" })).toHaveCount(1);
  expect(submissions).toBe(1);
});
