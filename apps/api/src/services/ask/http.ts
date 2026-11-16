import { AskFailure, abortFailure } from "./errors.js";

/** Buffer a bounded response including the streamed body, within one deadline.
 * No redirects, automatic auth discovery or retries can move a bearer elsewhere. */
export async function boundedFetch(
  url: string,
  init: RequestInit,
  options: { fetchImpl?: typeof fetch; timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signals = [
    timeout,
    ...(options.signal ? [options.signal] : []),
    ...(init.signal ? [init.signal] : []),
  ];
  const signal = AbortSignal.any(signals);
  try {
    signal.throwIfAborted();
    const response = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      signal,
      redirect: "error",
    });
    if (Number(response.headers.get("content-length")) > options.maxBytes) {
      await response.body?.cancel();
      throw new AskFailure("ASK_LIMIT_REACHED", 502);
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > options.maxBytes) throw new AskFailure("ASK_LIMIT_REACHED", 502);
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new Response(
      response.status === 204 || response.status === 205 || response.status === 304 ? null : bytes,
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  } catch (error) {
    if (signal.aborted) throw abortFailure(signal);
    if (error instanceof AskFailure) throw error;
    // Do not preserve provider exception text/causes: URLs and headers may leak.
    throw new AskFailure("ASK_UNAVAILABLE");
  }
}
