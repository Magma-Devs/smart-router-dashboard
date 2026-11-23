import { crc32 } from "node:zlib";

/**
 * ConverseStream for the synthetic and evaluation providers: a Converse
 * response replayed as the AWS event stream Bedrock answers with, and a
 * stream read back into a Converse response for the live observer.
 */

function message(headers, payload) {
  const headerBytes = Buffer.concat(
    Object.entries(headers).map(([name, value]) => {
      const n = Buffer.from(name, "utf8");
      const v = Buffer.from(value, "utf8");
      const part = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
      let at = part.writeUInt8(n.length, 0);
      at += n.copy(part, at);
      at = part.writeUInt8(7, at);
      at = part.writeUInt16BE(v.length, at);
      v.copy(part, at);
      return part;
    }),
  );
  const body = Buffer.from(payload, "utf8");
  const total = 12 + headerBytes.length + body.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headerBytes.length, 4);
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  headerBytes.copy(out, 12);
  body.copy(out, 12 + headerBytes.length);
  out.writeUInt32BE(crc32(out.subarray(0, total - 4)), total - 4);
  return out;
}

const event = (type, payload) =>
  message(
    { ":event-type": type, ":content-type": "application/json", ":message-type": "event" },
    JSON.stringify(payload),
  );

/** The events Bedrock streams for one Converse response: a text block opens on
 * its first delta, a tool call has a start event and its input in two pieces. */
export function converseStreamBody(response) {
  return Buffer.concat(converseStreamFrames(response));
}

function converseStreamFrames(response) {
  const frames = [event("messageStart", { role: "assistant" })];
  response.output.message.content.forEach((block, index) => {
    if (typeof block.text === "string") {
      // A few words a delta, as the model sends them.
      for (const piece of block.text.match(/(?:\S+\s*){1,3}|\s+/g) ?? [""])
        frames.push(
          event("contentBlockDelta", { contentBlockIndex: index, delta: { text: piece } }),
        );
    } else {
      const { input, ...start } = block.toolUse;
      const json = JSON.stringify(input);
      const cut = Math.ceil(json.length / 2);
      frames.push(
        event("contentBlockStart", { contentBlockIndex: index, start: { toolUse: start } }),
      );
      for (const piece of [json.slice(0, cut), json.slice(cut)])
        frames.push(
          event("contentBlockDelta", {
            contentBlockIndex: index,
            delta: { toolUse: { input: piece } },
          }),
        );
    }
    frames.push(event("contentBlockStop", { contentBlockIndex: index }));
  });
  frames.push(event("messageStop", { stopReason: response.stopReason }));
  if (response.usage) frames.push(event("metadata", { usage: response.usage }));
  return frames;
}

/** The stream as a response; `delayMs` between frames lets a browser test
 * watch the answer arrive as it does from Bedrock. */
export function converseStreamResponse(response, headers = {}, delayMs = 0) {
  const init = { headers: { "content-type": "application/vnd.amazon.eventstream", ...headers } };
  if (!delayMs) return new Response(converseStreamBody(response), init);
  const frames = converseStreamFrames(response);
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (index >= frames.length) return controller.close();
      if (index) await new Promise((resolve) => setTimeout(resolve, delayMs));
      controller.enqueue(new Uint8Array(frames[index++]));
    },
  });
  return new Response(body, init);
}

/** A ConverseStream body read back into the Converse response it carries. */
export function converseFromStream(bytes) {
  const blocks = [];
  const result = { output: { message: { role: "assistant", content: blocks } } };
  let at = 0;
  while (at + 12 <= bytes.length) {
    const total = bytes.readUInt32BE(at);
    const headersLength = bytes.readUInt32BE(at + 4);
    const headers = {};
    let h = at + 12;
    while (h < at + 12 + headersLength) {
      const nameLength = bytes.readUInt8(h);
      const name = bytes.toString("utf8", h + 1, h + 1 + nameLength);
      const valueLength = bytes.readUInt16BE(h + 2 + nameLength);
      headers[name] = bytes.toString("utf8", h + 4 + nameLength, h + 4 + nameLength + valueLength);
      h += 4 + nameLength + valueLength;
    }
    const payload = JSON.parse(
      bytes.toString("utf8", at + 12 + headersLength, at + total - 4) || "{}",
    );
    at += total;
    if (headers[":message-type"] !== "event") {
      result.exception = headers[":exception-type"] ?? "unknown";
      continue;
    }
    const index = payload.contentBlockIndex;
    switch (headers[":event-type"]) {
      case "contentBlockStart":
        if (payload.start?.toolUse)
          blocks[index] = { toolUse: { ...payload.start.toolUse }, json: "" };
        break;
      case "contentBlockDelta":
        if (typeof payload.delta?.text === "string") {
          blocks[index] ??= { text: "" };
          blocks[index].text += payload.delta.text;
        } else if (payload.delta?.toolUse) blocks[index].json += payload.delta.toolUse.input;
        else blocks[index] ??= { unknown: Object.keys(payload.delta ?? {}) };
        break;
      case "messageStop":
        result.stopReason = payload.stopReason;
        break;
      case "metadata":
        result.usage = payload.usage;
        break;
    }
  }
  for (const block of blocks)
    if (block?.json !== undefined) {
      try {
        block.toolUse.input = JSON.parse(block.json || "{}");
      } catch {
        block.toolUse.input = undefined;
      }
      delete block.json;
    }
  return result;
}
