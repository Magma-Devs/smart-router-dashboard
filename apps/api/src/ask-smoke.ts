import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { askAnswerSchema, type AskRun } from "@sr/shared";
import { boundedFetch } from "./services/ask/http.js";

/** Operator smoke uses the public admission/worker/accounting path. Supply a
 * current dashboard session securely; never put its value in shell history. */
async function smoke(): Promise<void> {
  const url = new URL(process.env.ASK_DATA_SMOKE_API_URL ?? "");
  const token = process.env.ASK_DATA_SMOKE_SESSION_TOKEN ?? "";
  if (
    process.env.ASK_DATA_SMOKE !== "true" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) ||
    !token ||
    /\s/.test(token)
  )
    throw new Error("SMOKE_NOT_CONFIGURED");
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await boundedFetch(
      new URL(path, url).toString(),
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { timeoutMs: 20_000, maxBytes: 1024 * 1024 },
    );
    if (!response.ok) throw new Error("SMOKE_API_UNAVAILABLE");
    return (await response.json()) as T;
  };
  const capabilities = await request<{ acceptingQuestions: boolean }>("/api/ask/capabilities");
  if (!capabilities.acceptingQuestions) throw new Error("SMOKE_API_UNAVAILABLE");
  const chat = await request<{ id: string }>("/api/ask/chats", {});
  const run = await request<AskRun>(`/api/ask/chats/${chat.id}/runs`, {
    idempotencyKey: randomUUID(),
    question:
      "Using current authorized metrics, explain the count(up) result and what it cannot establish about router health. State the actual source, observation time and limitations.",
    context: { page: "ask" },
  });
  const deadline = Date.now() + 125_000;
  while (Date.now() < deadline) {
    const state = await request<AskRun>(`/api/ask/runs/${run.id}`);
    if (state.status === "succeeded") {
      const answer = askAnswerSchema.parse(state.answer);
      process.stdout.write(
        JSON.stringify({
          ok: true,
          timestamp: new Date().toISOString(),
          chatId: chat.id,
          runId: run.id,
          answerValidated: true,
          sections: answer.sections.length,
          evidence: answer.evidence,
          limits: [
            "One real metered question through the customer API",
            "No browser/UI/pilot acceptance",
          ],
        }) + "\n",
      );
      return;
    }
    if (["failed", "cancelled", "interrupted"].includes(state.status))
      throw new Error("SMOKE_RUN_FAILED");
    await wait(500);
  }
  await request(`/api/ask/runs/${run.id}/cancel`, {}).catch(() => undefined);
  throw new Error("SMOKE_TIMEOUT");
}
try {
  await smoke();
} catch {
  // Session/provider/ORM exceptions can contain secrets: fixed code only.
  process.stderr.write(
    JSON.stringify({ ok: false, timestamp: new Date().toISOString(), code: "SMOKE_FAILED" }) + "\n",
  );
  process.exitCode = 1;
}
