import { writeFileSync } from "node:fs";
import { askAnswerSchema, type AskRun } from "@sr/shared";
import { test as base, expect } from "@playwright/test";
import { createDb } from "@sr/db";
import { signInThroughUi, type Operator } from "../support/fixtures.js";
import { createFirstAdmin, enrolAuthenticator, signInApi } from "../support/api.js";
import { assertDisposableDatabase } from "../support/db.js";
import { DATABASE_URL, OPERATOR } from "../support/env.js";

// Reset disposable accounts/content, retaining every actual financial receipt
// and monthly pool across retries of this explicitly invoked live check.
const test = base.extend<object, { operator: Operator }>({
  operator: [
    async ({}, use) => {
      assertDisposableDatabase(DATABASE_URL);
      const handle = createDb(DATABASE_URL);
      try {
        const before =
          await handle.sql`select * from ask_budget_months order by customer_id, month`;
        const steps = await handle.sql`select count(*)::int as count from ask_model_steps`;
        const tables = await handle.sql<
          { name: string }[]
        >`select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname='public' and tablename not in ('ask_budget_months','ask_model_steps')`;
        if (tables.length)
          await handle.sql.unsafe(
            `truncate table ${tables.map((t) => t.name).join(",")} restart identity cascade`,
          );
        expect(
          await handle.sql`select * from ask_budget_months order by customer_id, month`,
        ).toEqual(before);
        expect(await handle.sql`select count(*)::int as count from ask_model_steps`).toEqual(steps);
        await createFirstAdmin();
        const session = await signInApi(OPERATOR.email, OPERATOR.password);
        const authenticator = await enrolAuthenticator(session.token);
        await use({ ...OPERATOR, userId: session.userId, token: session.token, authenticator });
      } finally {
        await handle.sql.end();
      }
    },
    { scope: "worker" },
  ],
});
import { apiCall } from "../support/api.js";

/** Explicitly invoked on disposable local accounts, with real scoped providers.
 * No screenshots, traces, answer text, raw source values or credentials saved. */
test("live browser questions use normal admission, providers and persisted answers", async ({
  page,
  operator,
}) => {
  const records: Array<Record<string, unknown>> = [];
  await signInThroughUi(page, operator);
  await page.getByRole("link", { name: "Ask your data" }).click();
  await expect(page.getByLabel("Ask a question")).toBeVisible();
  const prompts = [
    "Using the currently authorized metrics, run count(up) and explain the result and what it cannot establish about router health. State the actual source and observation time. Keep the answer short.",
    "Inspect at most 20 recent Smart Router log entries from the last five minutes, discovering current log labels if needed. Summarize observed errors and limitations. No entries in that window do not prove service health. Keep the answer short.",
    "Does the approved catalog contain an actual provider-status operation? Explain what status evidence is available and what cannot be established. Use an authorized read for current context. Do not invent provider events or infer causality from timing. Keep the answer short.",
  ];
  try {
    for (const [index, prompt] of prompts.entries()) {
      await page.getByLabel("Ask a question").fill(prompt);
      const admission = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          /\/api\/ask\/chats\/[^/]+\/runs$/.test(new URL(r.url()).pathname),
      );
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const response = await admission;
      expect(response.status()).toBeLessThan(300);
      const admitted = (await response.json()) as AskRun;
      let terminal: AskRun | null = null;
      await expect
        .poll(
          async () => {
            const result = await apiCall<AskRun>("GET", `/api/ask/runs/${admitted.id}`, {
              token: operator.token,
            });
            if (result.status !== 200 || !result.body) return false;
            if (["succeeded", "failed", "cancelled", "interrupted"].includes(result.body.status))
              terminal = result.body;
            return terminal !== null;
          },
          { timeout: 135_000, intervals: [500, 1000, 1500] },
        )
        .toBe(true);
      const run = terminal as AskRun | null;
      if (!run) throw new Error("LIVE_RUN_MISSING");
      const valid = askAnswerSchema.safeParse(run.answer);
      const record: Record<string, unknown> = {
        runId: run.id,
        chatId: run.chatId,
        status: run.status,
        errorCode: run.error?.code,
        contractValid: valid.success,
        evidence: valid.success ? valid.data.evidence : [],
        shownInView: false,
        reloadVerified: false,
      };
      records.push(record);
      if (run.status !== "succeeded") throw new Error(`LIVE_RUN_${run.error?.code ?? "FAILED"}`);
      expect(valid.success).toBe(true);
      if (!valid.success) throw new Error("LIVE_INVALID_CONTRACT");
      if (index === 2) {
        const prose = [
          valid.data.summary,
          ...valid.data.sections.flatMap((s) => [s.title, s.body, ...(s.points ?? [])]),
        ].join(" ");
        const caveat =
          /status/i.test(prose) &&
          /\b(unavailable|missing|absent)\b|\b(does not|doesn't|not|no)\b.{0,100}\b(status|provider|catalog|operation|source|available|present|access)\b/i.test(
            prose,
          );
        record.missingStatusCaveat = caveat;
        if (!caveat) throw new Error("LIVE_STATUS_CAVEAT_MISSING");
      }
      expect(valid.data.evidence.length > 0).toBe(true);
      expect(
        valid.data.evidence.every((e) =>
          (JSON.parse(process.env.E2E_ASK_LIVE_SOURCE_IDS!) as string[]).includes(e.sourceId),
        ),
      ).toBe(true);
      if (index === 0 || index === 1) {
        const operation = index === 0 ? "metrics.query" : "logs.query_range";
        const reads = valid.data.evidence.filter((e) => e.operationId === operation);
        expect(reads.length).toBeGreaterThan(0);
        for (const read of reads) {
          // Relative questions must use the current server clock, not a model
          // generated calendar conversion from another year.
          expect(read.from !== undefined && read.to !== undefined).toBe(true);
          if (!read.from || !read.to) throw new Error("LIVE_MISSING_TIME_BOUND");
          expect(Date.parse(read.from)).toBeGreaterThanOrEqual(
            Date.parse(admitted.createdAt) - 7 * 60_000,
          );
          expect(Date.parse(read.to)).toBeLessThanOrEqual(Date.now() + 5000);
        }
      }
      await expect.poll(() => page.locator(".ask-answer").count()).toBe(index + 1);
      record.shownInView = true;
      await page.reload();
      await expect.poll(() => page.locator(".ask-answer").count()).toBe(index + 1);
      record.reloadVerified = true;
    }
  } finally {
    // Playwright can otherwise attach a page snapshot to a failure even with
    // tracing/screenshots disabled. Close live customer content first.
    await page.close();
    writeFileSync(
      process.env.E2E_ASK_LIVE_RESULT_FILE || "/private/tmp/sr-ask-live-browser-result.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          rawDataInArtifact: false,
          credentialsSaved: false,
          records,
        },
        null,
        2,
      ) + "\n",
    );
  }
});
