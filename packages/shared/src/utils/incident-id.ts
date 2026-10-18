/**
 * A random UUID (version 4) for an incident report, minted by the form when it
 * opens and sent with every attempt, so a retry joins the report it repeats.
 *
 * Not `crypto.randomUUID()`: that exists only in a secure context, and an
 * on-prem dashboard served over plain http is not one. `getRandomValues` is
 * available everywhere `crypto` is.
 */
/** The one Web Crypto call this needs. This package is built without the DOM
 *  or Node type libraries, and both runtimes provide it on `globalThis`. */
interface RandomSource {
  getRandomValues(bytes: Uint8Array): Uint8Array;
}

export function newIncidentId(
  fill: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    (globalThis as unknown as { crypto: RandomSource }).crypto.getRandomValues(bytes),
): string {
  const b = fill(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
