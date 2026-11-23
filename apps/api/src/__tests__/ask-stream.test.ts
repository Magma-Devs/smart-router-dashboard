import { afterEach, describe, expect, it, vi } from "vitest";
import { readAskSettings } from "../config.js";
import { BedrockAdapter } from "../services/ask/bedrock.js";
import { AskFailure } from "../services/ask/errors.js";
import {
  EventStreamDecoder,
  EventStreamError,
  encodeEventStreamMessage,
} from "../services/ask/event-stream.js";
import { draftText } from "../services/ask/draft.js";
import { DraftWriter } from "../services/ask/worker.js";
import { runProgress } from "../services/ask/progress.js";
// @ts-expect-error The browser tests' provider helper is plain JavaScript.
import {
  converseFromStream,
  converseStreamResponse,
} from "../../../../e2e/support/converse-stream.mjs";

const settings = () =>
  readAskSettings({
    ASK_DATA_ENABLED: "true",
    AUTH_MODE: "enabled",
    DEPLOYMENT_MODE: "managed",
    ASK_DATA_CUSTOMER_ID: "acme",
    ASK_DATA_MCP_TOKEN: "customer-test-token",
    AWS_BEARER_TOKEN_BEDROCK: "bedrock-test-token",
    ASK_DATA_BEDROCK_MODEL: "global.anthropic.claude-sonnet-5",
  });
const input = {
  system: "System policy",
  messages: [{ role: "user" as const, content: [{ text: "Which chains failed?" }] }],
  tools: [{ name: "present_answer", description: "Answer", inputSchema: { type: "object" } }],
};
const usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadInputTokens: 5 };
afterEach(() => vi.restoreAllMocks());

const event = (type: string, payload: unknown) =>
  encodeEventStreamMessage(
    { ":event-type": type, ":content-type": "application/json", ":message-type": "event" },
    JSON.stringify({ ...(payload as object), p: "abcdefgh" }),
  );
const answer = { kind: "data" };
const answerJson = JSON.stringify(answer);
const ANSWER_TEXT = "Two chains **failed** today.";
/** A ConverseStream reply: a preface text block, then present_answer whose
 * input arrives in three pieces, then the stop reason and usage. */
function replyEvents(json = answerJson): Buffer[] {
  const cut = [0, 12, 30, json.length];
  return [
    event("messageStart", { role: "assistant" }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Two chains " } }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "**failed** today." } }),
    event("contentBlockStop", { contentBlockIndex: 0 }),
    event("contentBlockStart", {
      contentBlockIndex: 1,
      start: { toolUse: { toolUseId: "tool-1", name: "present_answer" } },
    }),
    ...cut.slice(1).map((end, i) =>
      event("contentBlockDelta", {
        contentBlockIndex: 1,
        delta: { toolUse: { input: json.slice(cut[i], end) } },
      }),
    ),
    event("contentBlockStop", { contentBlockIndex: 1 }),
    event("messageStop", { stopReason: "tool_use" }),
    event("metadata", { usage, metrics: { latencyMs: 900 } }),
  ];
}
/** The frames as a body, split every `size` bytes so frames straddle chunks. */
function streamResponse(frames: Buffer[], size = 7, status = 200): Response {
  const bytes = Buffer.concat(frames);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size)
        controller.enqueue(new Uint8Array(bytes.subarray(at, at + size)));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/vnd.amazon.eventstream",
      "x-amzn-requestid": "req-1",
    },
  });
}
async function converse(frames: Buffer[], onDraft = vi.fn(), size = 7) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(frames, size));
  const onUsage = vi.fn().mockResolvedValue(undefined);
  const call = new BedrockAdapter(settings(), fetchImpl).converse(input, {
    onUsage,
    onDispatch: async () => undefined,
    onDraft,
  });
  return { call, fetchImpl, onUsage, onDraft };
}

describe("the event stream decoder", () => {
  it("decodes frames split at any byte, checking both checksums", () => {
    const frames = Buffer.concat([event("messageStart", { role: "assistant" }), event("x", {})]);
    for (const size of [1, 5, 13, frames.length]) {
      const decoder = new EventStreamDecoder();
      const messages = [];
      for (let at = 0; at < frames.length; at += size)
        messages.push(...decoder.push(frames.subarray(at, at + size)));
      decoder.finish();
      expect(messages.map((m) => m.headers[":event-type"])).toEqual(["messageStart", "x"]);
      expect(JSON.parse(messages[0]!.payload.toString()).role).toBe("assistant");
    }
  });
  it("refuses a corrupted frame and a body cut mid-frame", () => {
    const frame = event("messageStart", { role: "assistant" });
    const payloadFlip = Buffer.from(frame);
    payloadFlip[frame.length - 6] ^= 1;
    expect(() => new EventStreamDecoder().push(payloadFlip)).toThrow(EventStreamError);
    const preludeFlip = Buffer.from(frame);
    preludeFlip[3] ^= 1;
    expect(() => new EventStreamDecoder().push(preludeFlip)).toThrow(EventStreamError);
    const cut = new EventStreamDecoder();
    expect(cut.push(frame.subarray(0, frame.length - 1))).toEqual([]);
    expect(() => cut.finish()).toThrow(EventStreamError);
  });
});

describe("the answer text still being written", () => {
  it("shows whole words only, at most the answer limit, redacted", () => {
    expect(draftText({ text: "Two chains fai", complete: false }, [])).toBe("Two chains");
    expect(draftText({ text: "Two chains failed.", complete: true }, [])).toBe(
      "Two chains failed.",
    );
    expect(draftText({ text: "Partial", complete: false }, [])).toBe("");
    expect(draftText({ text: "word ".repeat(2000), complete: true }, []).length).toBeLessThan(8000);
    // A credential is never shown, whole or while it is still arriving.
    const secret = "bedrock-test-token-0123456789";
    expect(draftText({ text: `Key ${secret} leaked`, complete: true }, [secret])).toBe(
      "Key [redacted] leaked",
    );
    expect(draftText({ text: `Key ${secret.slice(0, 12)}`, complete: false }, [secret])).toBe(
      "Key",
    );
    expect(draftText({ text: "See https://node.test/abc/key123 now", complete: true }, [])).toBe(
      "See https://node.test/[redacted] now",
    );
  });
});

describe("a streamed model step", () => {
  it("calls ConverseStream and returns the step a buffered call returns", async () => {
    const { call, fetchImpl, onUsage, onDraft } = await converse(replyEvents());
    const step = await call;
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-sonnet-5/converse-stream",
    );
    expect(step.stopReason).toBe("tool_use");
    expect(step.message.content).toEqual([
      { text: ANSWER_TEXT },
      { toolUse: { toolUseId: "tool-1", name: "present_answer", input: answer } },
    ]);
    expect(step.receipt).toEqual({ requestId: "req-1", providerStatus: 200 });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(usage, step.receipt);
    // The answer text is drafted as it arrives, then whole once the closing call starts.
    const drafts = onDraft.mock.calls.map(([draft]) => draft);
    expect(drafts[0]).toEqual({ text: "Two chains ", complete: false });
    expect(drafts.at(-1)).toEqual({ text: ANSWER_TEXT, complete: true });
  });
  it("withdraws text written before a read", async () => {
    const frames = [
      event("messageStart", { role: "assistant" }),
      event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Let me check." } }),
      event("contentBlockStart", {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: "t", name: "router_request_summary" } },
      }),
      event("contentBlockDelta", {
        contentBlockIndex: 1,
        delta: { toolUse: { input: "{}" } },
      }),
      event("contentBlockDelta", { contentBlockIndex: 2, delta: { text: "More text." } }),
      event("messageStop", { stopReason: "tool_use" }),
      event("metadata", { usage }),
    ];
    const { call, onDraft } = await converse(frames);
    await call;
    expect(onDraft.mock.calls.map(([draft]) => draft)).toEqual([
      { text: "Let me check.", complete: false },
      { text: "", complete: true },
    ]);
  });
  it("keeps a buffered Converse call for a caller with no draft consumer", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        output: { message: { role: "assistant", content: [{ text: "ok" }] } },
        stopReason: "end_turn",
        usage,
      }),
    );
    await new BedrockAdapter(settings(), fetchImpl).converse(input, {
      onUsage: vi.fn(),
      onDispatch: async () => undefined,
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toMatch(/\/converse$/);
  });
  it("records the usage and then refuses a stream with a content event it does not know", async () => {
    const frames = replyEvents();
    frames.splice(
      1,
      0,
      event("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { reasoningContent: { text: "hmm" } },
      }),
    );
    const { call, onUsage } = await converse(frames);
    await expect(call).rejects.toMatchObject({ code: "ASK_INVALID_ANSWER" });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(usage, expect.anything());
  });
  it("refuses tool input that is not whole JSON, after recording the usage", async () => {
    const { call, onUsage } = await converse(replyEvents('{"summary":"cut'));
    await expect(call).rejects.toMatchObject({ code: "ASK_INVALID_ANSWER" });
    expect(onUsage).toHaveBeenCalledWith(usage, expect.anything());
  });
  it("ends a stream with an exception event as a provider failure with unknown usage", async () => {
    const frames = replyEvents().slice(0, 6);
    frames.push(
      encodeEventStreamMessage(
        { ":message-type": "exception", ":exception-type": "modelStreamErrorException" },
        JSON.stringify({ message: "stream broke" }),
      ),
    );
    const { call, onUsage } = await converse(frames);
    await expect(call).rejects.toMatchObject({ code: "ASK_BEDROCK_UNAVAILABLE" });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(null, {
      requestId: "req-1",
      providerStatus: 200,
    });
  });
  it("leaves the usage unknown when the stream is cut mid-frame", async () => {
    const bytes = Buffer.concat(replyEvents());
    const { call, onUsage } = await converse([bytes.subarray(0, bytes.length - 5)]);
    await expect(call).rejects.toBeInstanceOf(AskFailure);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(null, expect.anything());
  });
  it("refuses a stream larger than the response ceiling", async () => {
    const big = Array.from({ length: 400 }, () =>
      event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "x".repeat(4000) } }),
    );
    const { call, onUsage } = await converse(
      [...replyEvents().slice(0, 2), ...big],
      vi.fn(),
      65_536,
    );
    await expect(call).rejects.toMatchObject({ code: "ASK_LIMIT_REACHED" });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(null, expect.anything());
  });
  it("counts a non-2xx stream as a provider failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"message":"denied"}', { status: 403 }));
    const onUsage = vi.fn().mockResolvedValue(undefined);
    await expect(
      new BedrockAdapter(settings(), fetchImpl).converse(input, {
        onUsage,
        onDispatch: async () => undefined,
        onDraft: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "ASK_BEDROCK_UNAVAILABLE" });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(null, { requestId: null, providerStatus: 403 });
  });
  it("skips an event type it does not know", async () => {
    const frames = replyEvents();
    frames.splice(1, 0, event("serviceNotice", { note: "new" }));
    const { call } = await converse(frames);
    await expect(call).resolves.toMatchObject({ stopReason: "tool_use" });
  });
  it("keeps going when the draft consumer throws", async () => {
    const { call } = await converse(
      replyEvents(),
      vi.fn(() => {
        throw new Error("consumer bug");
      }),
    );
    await expect(call).resolves.toMatchObject({ stopReason: "tool_use" });
  });
});

describe("the browser tests' synthetic stream", () => {
  it("is read by the adapter as the Converse response it replays", async () => {
    const converse = {
      output: {
        message: {
          role: "assistant",
          content: [
            { text: "Preface" },
            {
              toolUse: { toolUseId: "t1", name: "present_answer", type: "tool_use", input: answer },
            },
          ],
        },
      },
      stopReason: "tool_use",
      usage,
    };
    const response = converseStreamResponse(converse, { "x-amzn-requestid": "fixture" });
    const bytes = Buffer.from(await response.clone().arrayBuffer());
    expect(converseFromStream(bytes)).toEqual(converse);
    const onDraft = vi.fn();
    const step = await new BedrockAdapter(
      settings(),
      vi.fn<typeof fetch>().mockResolvedValue(response),
    ).converse(input, { onUsage: vi.fn(), onDispatch: async () => undefined, onDraft });
    // The response schema drops the tool call's `type`, as it does for Converse.
    expect(step.message.content).toEqual([
      { text: "Preface" },
      { toolUse: { toolUseId: "t1", name: "present_answer", input: answer } },
    ]);
    expect(step.receipt.requestId).toBe("fixture");
    expect(onDraft).toHaveBeenLastCalledWith({ text: "Preface", complete: true });
  });
});

describe("the draft writer", () => {
  it("writes the newest text at most once per interval, one write at a time", async () => {
    vi.useFakeTimers();
    try {
      const written: string[] = [];
      let release!: () => void;
      const writer = new DraftWriter(async (text) => {
        written.push(text);
        if (written.length === 1) await new Promise<void>((resolve) => (release = resolve));
      }, 500);
      writer.publish("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(written).toEqual(["a"]);
      writer.publish("b");
      writer.publish("c");
      await vi.advanceTimersByTimeAsync(1000);
      expect(written).toEqual(["a"]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(written).toEqual(["a", "c"]);
      writer.publish("c");
      await vi.advanceTimersByTimeAsync(1000);
      expect(written).toEqual(["a", "c"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("writes nothing after close, and close waits for the write in flight", async () => {
    vi.useFakeTimers();
    try {
      const written: string[] = [];
      let finished = false;
      const writer = new DraftWriter(async (text) => {
        written.push(text);
        await new Promise((resolve) => setTimeout(resolve, 100));
        finished = true;
      }, 500);
      writer.publish("a");
      await vi.advanceTimersByTimeAsync(0);
      writer.publish("b");
      const closing = writer.close();
      await vi.advanceTimersByTimeAsync(100);
      await closing;
      expect(finished).toBe(true);
      writer.publish("c");
      await vi.advanceTimersByTimeAsync(2000);
      expect(written).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the draft in a running run's progress", () => {
  it("carries a draft only when there is one", () => {
    expect(runProgress([], [], "Two chains failed.").draft).toBe("Two chains failed.");
    expect(runProgress([], [], null)).not.toHaveProperty("draft");
    expect(runProgress([], [], "")).not.toHaveProperty("draft");
  });
});
