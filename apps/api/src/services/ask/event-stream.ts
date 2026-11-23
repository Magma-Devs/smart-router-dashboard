import { crc32 } from "node:zlib";

/** One message of the AWS event stream encoding (application/vnd.amazon.eventstream). */
export interface StreamMessage {
  headers: Record<string, string | number | boolean>;
  payload: Buffer;
}

/** The largest message this decoder accepts. A Converse stream event is a few KiB. */
const MAX_MESSAGE_BYTES = 1024 * 1024;

export class EventStreamError extends Error {}

/**
 * Decodes the binary frames ConverseStream answers with: a 12-byte prelude
 * (total length, headers length, prelude CRC32), the headers, the payload and a
 * CRC32 of everything before it. Both checksums are verified; any mismatch,
 * oversize frame or trailing partial frame throws.
 */
export class EventStreamDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): StreamMessage[] {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const messages: StreamMessage[] = [];
    while (this.buffer.length >= 12) {
      const total = this.buffer.readUInt32BE(0);
      const headersLength = this.buffer.readUInt32BE(4);
      if (total < 16 || total > MAX_MESSAGE_BYTES || headersLength > total - 16)
        throw new EventStreamError("Invalid event stream prelude");
      if (crc32(this.buffer.subarray(0, 8)) !== this.buffer.readUInt32BE(8))
        throw new EventStreamError("Event stream prelude checksum mismatch");
      if (this.buffer.length < total) break;
      if (crc32(this.buffer.subarray(0, total - 4)) !== this.buffer.readUInt32BE(total - 4))
        throw new EventStreamError("Event stream message checksum mismatch");
      messages.push({
        headers: decodeHeaders(this.buffer.subarray(12, 12 + headersLength)),
        payload: Buffer.from(this.buffer.subarray(12 + headersLength, total - 4)),
      });
      this.buffer = this.buffer.subarray(total);
    }
    return messages;
  }

  /** The body ended: a partial frame left over means the stream was cut. */
  finish(): void {
    if (this.buffer.length) throw new EventStreamError("Event stream ended mid-message");
  }
}

function decodeHeaders(bytes: Buffer): Record<string, string | number | boolean> {
  const headers: Record<string, string | number | boolean> = {};
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.length) throw new EventStreamError("Truncated event stream header");
  };
  while (at < bytes.length) {
    need(1);
    const nameLength = bytes.readUInt8(at++);
    need(nameLength + 1);
    const name = bytes.toString("utf8", at, at + nameLength);
    at += nameLength;
    const type = bytes.readUInt8(at++);
    switch (type) {
      case 0:
      case 1:
        headers[name] = type === 0;
        break;
      case 2:
        need(1);
        headers[name] = bytes.readInt8(at);
        at += 1;
        break;
      case 3:
        need(2);
        headers[name] = bytes.readInt16BE(at);
        at += 2;
        break;
      case 4:
        need(4);
        headers[name] = bytes.readInt32BE(at);
        at += 4;
        break;
      case 5:
      case 8:
        need(8);
        headers[name] = Number(bytes.readBigInt64BE(at));
        at += 8;
        break;
      case 6:
      case 7: {
        need(2);
        const length = bytes.readUInt16BE(at);
        at += 2;
        need(length);
        headers[name] =
          type === 7
            ? bytes.toString("utf8", at, at + length)
            : bytes.toString("hex", at, at + length);
        at += length;
        break;
      }
      case 9:
        need(16);
        headers[name] = bytes.toString("hex", at, at + 16);
        at += 16;
        break;
      default:
        throw new EventStreamError("Unknown event stream header type");
    }
  }
  return headers;
}

/** Encodes one message; the tests build provider streams with it. */
export function encodeEventStreamMessage(
  headers: Record<string, string>,
  payload: Buffer | string,
): Buffer {
  const headerParts = Object.entries(headers).map(([name, value]) => {
    const nameBytes = Buffer.from(name, "utf8");
    const valueBytes = Buffer.from(value, "utf8");
    const part = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    let at = part.writeUInt8(nameBytes.length, 0);
    at += nameBytes.copy(part, at);
    at = part.writeUInt8(7, at);
    at = part.writeUInt16BE(valueBytes.length, at);
    valueBytes.copy(part, at);
    return part;
  });
  const headerBytes = Buffer.concat(headerParts);
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const total = 12 + headerBytes.length + body.length + 4;
  const message = Buffer.alloc(total);
  message.writeUInt32BE(total, 0);
  message.writeUInt32BE(headerBytes.length, 4);
  message.writeUInt32BE(crc32(message.subarray(0, 8)), 8);
  headerBytes.copy(message, 12);
  body.copy(message, 12 + headerBytes.length);
  message.writeUInt32BE(crc32(message.subarray(0, total - 4)), total - 4);
  return message;
}
