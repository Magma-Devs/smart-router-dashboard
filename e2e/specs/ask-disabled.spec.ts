import { test, expect, signInThroughUi } from "../support/fixtures.js";
import { apiCall } from "../support/api.js";

test("disabled/self-hosted chat has no entry, personal calls or direct-route access", async ({
  page,
  operator,
}) => {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/ask/")) calls.push(request.url());
  });
  await signInThroughUi(page, operator);
  await expect(page.getByRole("link", { name: /AI investigation/ })).toHaveCount(0);
  await page.goto("/ask");
  await expect(page.getByRole("heading", { name: "Chat is unavailable" })).toBeVisible();
  await expect(page.getByLabel("Ask a question")).toHaveCount(0);
  expect(calls).toHaveLength(0);
  expect((await apiCall("GET", "/api/ask/capabilities", { token: operator.token })).status).toBe(
    404,
  );
});
