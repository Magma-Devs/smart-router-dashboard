import { test, expect, signInThroughUi, enrolledMember } from "../support/fixtures.js";
import { apiCall, inviteMember, nextClientIp } from "../support/api.js";
import { API_URL } from "../support/env.js";

test.beforeEach(async ({ context }) => {
  // Context options can be reused with the worker. Give each flow its own
  // ingress client address without changing the production rate limits.
  await context.setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
});

test("router-scoped questions preserve both filter axes through panel, full view and reload", async ({
  page,
  operator,
}) => {
  await page.route("**/api/config/routers", (route) =>
    route.fulfill({
      json: {
        routers: ["eth-primary", "eth-secondary"].map((id) => ({
          id,
          spec: "ETH1",
          network: "mainnet",
          pathBased: false,
          customUrlPrefix: null,
          localPort: null,
          localPorts: {},
          publicUrls: {},
          interfaces: ["jsonrpc"],
          nodes: [],
        })),
      },
    }),
  );
  await page.route("**/api/metrics/routers", (route) =>
    route.fulfill({
      json: {
        label: "service",
        routers: ["eth-primary-router", "eth-secondary-router"],
      },
    }),
  );
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
  await page.getByRole("button", { name: "Filter by router" }).click();
  await page.getByRole("button", { name: /eth-primary/ }).click();
  await page.getByRole("button", { name: "Ask your data" }).click();
  const panel = page.getByRole("complementary", { name: "Ask your data" });
  await panel.getByLabel("Ask a question").fill("ROUTER_CONTEXT_FIXTURE selected router");
  const submission = page.waitForRequest(
    (request) =>
      request.method() === "POST" && /\/api\/ask\/chats\/[^/]+\/runs$/.test(request.url()),
  );
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  const first = await submission;
  expect(first.postDataJSON().context).toMatchObject({
    page: "upstreams",
    chain: "ETH1",
    router: "eth-primary-router",
    routerId: "eth-primary",
  });
  expect((await first.response())?.status()).toBe(200);
  await expect(panel.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  await panel.getByRole("button", { name: "Open full chat" }).click();
  await page.waitForURL(/\/ask\?chat=/);
  await page.reload();
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  await page.getByLabel("Ask a question").fill("ROUTER_CONTEXT_FIXTURE follow up");
  const followUp = page.waitForRequest(
    (request) =>
      request.method() === "POST" && /\/api\/ask\/chats\/[^/]+\/runs$/.test(request.url()),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const second = await followUp;
  expect(second.postDataJSON().context).toEqual(first.postDataJSON().context);
  expect((await second.response())?.status()).toBe(200);
  await expect(page.getByRole("article", { name: "Answer" })).toHaveCount(2);
});

test("panel/full chat preserves history, drafts, evidence, search, copy and mobile focus", async ({
  page,
  context,
  operator,
  browser,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInThroughUi(page, operator);
  await page.getByRole("button", { name: "Ask your data" }).click();
  const panel = page.getByRole("complementary", { name: "Ask your data" });
  await expect(panel).toBeVisible();
  await panel
    .getByLabel("Ask a question")
    .fill("PRIVATE_BROWSER_QUESTION What do current metrics show?");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Processing…" })).toBeVisible();
  await panel.getByRole("button", { name: "Minimize chat" }).click();
  await expect(page.getByRole("button", { name: /Open chat/ })).toBeVisible();
  await page.getByRole("button", { name: "Toggle theme" }).click(); // dashboard remains usable
  await page.getByRole("button", { name: /Open chat/ }).click();
  await expect(panel.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  await panel.locator("summary").filter({ hasText: "Sources and time window" }).click();
  await expect(panel.getByText("e2e-metrics", { exact: true })).toBeVisible();
  await expect(panel.getByText("<script>window.__askUnsafe=true</script>")).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __askUnsafe?: boolean }).__askUnsafe),
  ).toBeUndefined();
  await panel.getByRole("button", { name: "Copy answer", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "Source: e2e-metrics",
  );
  await panel.getByLabel("Ask a question").fill("Unsent follow-up draft");
  await panel.getByRole("button", { name: "Open full chat" }).click();
  await page.waitForURL(/\/ask\?chat=/);
  const chatUrl = page.url();
  await expect(page.getByLabel("Ask a question")).toHaveValue("Unsent follow-up draft");
  await page.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  await page.waitForURL(/\/metrics$/);
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Ask a question")).toHaveValue("Unsent follow-up draft");
  await panel.getByRole("button", { name: "Open full chat" }).click();
  await page.waitForURL(/\/ask\?chat=/);
  await page.reload();
  await expect(
    page
      .locator(".ask-question")
      .getByText("PRIVATE_BROWSER_QUESTION What do current metrics show?", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible();
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
  await page.screenshot({ path: testInfo.outputPath("ask-full-desktop.png"), fullPage: false });
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByLabel("Search your chats")).toBeVisible();
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Ask your data" });
  await expect(dialog).toBeVisible();
  expect(await page.locator(".gw-app").evaluate((element) => (element as HTMLElement).inert)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("ask-panel-mobile.png"), fullPage: false });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(await page.locator(".gw-app").evaluate((element) => (element as HTMLElement).inert)).toBe(
    false,
  );
  await page.goto(chatUrl);
  await expect(page.getByText("Three authorized fixture targets were returned.")).toBeVisible();
  await expect
    .poll(
      async () =>
        (await apiCall<{ view: string }>("GET", "/api/ask/preferences", { token: operator.token }))
          .body?.view,
    )
    .toBe("full");
  const stored = await context.storageState();
  const freshContext = await browser.newContext({
    storageState: { cookies: stored.cookies, origins: [] },
    extraHTTPHeaders: { "x-forwarded-for": nextClientIp() },
  });
  try {
    const fresh = await freshContext.newPage();
    await fresh.goto(new URL("/metrics", chatUrl).toString());
    await fresh.getByRole("button", { name: /Ask your data/ }).click();
    await fresh.waitForURL(chatUrl);
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
  await page.getByRole("button", { name: "+ New chat", exact: true }).first().click();
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
