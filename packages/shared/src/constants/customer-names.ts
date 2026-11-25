/**
 * Names a deployment's admins give the customer-id values its callers send.
 *
 * The router counts each request under the `customer-id` header exactly as the
 * caller sent it, often an opaque id. A name is the dashboard's own label for
 * one id: kept in the deployment's database, shown wherever the id is, and
 * never written to the metrics store.
 */

/** The longest name, in characters. */
export const CUSTOMER_NAME_MAX_LENGTH = 64;

/** The router's own bound on a customer-id value, in UTF-8 bytes; a longer one counts as `other`. */
export const CUSTOMER_ID_MAX_BYTES = 128;

/**
 * Values of the router's customer label that are not a caller's id: no header
 * sent, past the router's per-chain cap, and Magma's serving probe. None of
 * them takes a name, and no name may read as one of them.
 */
export const UNNAMEABLE_CUSTOMERS = ["DefaultDappID", "other", "magma-serving-probe"] as const;

/** Characters a name may not hold: they break a Markdown table, a code span, a link or HTML. */
const NAME_FORBIDDEN = /[|`<>\\[\]]/;
/** Control, format (zero-width, bidi), and line or paragraph separator characters. */
const NAME_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Control and format characters, and a lone surrogate (not UTF-8 at all). */
const ID_INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/** A string's length in UTF-8 bytes. */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export type CustomerNameParse = { ok: true; name: string } | { ok: false; problem: string };

/** A name as stored and compared: NFC, trimmed, inner runs of spaces as one. */
function canonicalName(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/** Two names that read the same, whatever their case: the database keeps one of them. */
export function sameCustomerName(a: string, b: string): boolean {
  return canonicalName(a).toLowerCase() === canonicalName(b).toLowerCase();
}

/** Whether a value is one of `UNNAMEABLE_CUSTOMERS`, in any case. */
export function isUnnameableCustomer(value: string): boolean {
  return UNNAMEABLE_CUSTOMERS.some((reserved) => sameCustomerName(reserved, value));
}

/**
 * An admin's typed name, made canonical, or what is wrong with it: one line of
 * 1 to `CUSTOMER_NAME_MAX_LENGTH` visible characters, none of `| \` < > \ [ ]`,
 * and not one of the reserved customer values.
 */
export function parseCustomerName(raw: unknown): CustomerNameParse {
  if (typeof raw !== "string") return { ok: false, problem: "A name is text." };
  if (NAME_INVISIBLE.test(raw.replace(/[\t\n\r]/g, " ")))
    return { ok: false, problem: "A name may not hold control or invisible characters." };
  const name = canonicalName(raw);
  if (name === "") return { ok: false, problem: "A name may not be empty." };
  if ([...name].length > CUSTOMER_NAME_MAX_LENGTH)
    return { ok: false, problem: `A name is at most ${CUSTOMER_NAME_MAX_LENGTH} characters.` };
  if (NAME_FORBIDDEN.test(name))
    return { ok: false, problem: "A name may not hold | ` < > \\ [ or ]." };
  if (isUnnameableCustomer(name))
    return { ok: false, problem: `"${name}" is a value the router uses itself.` };
  return { ok: true, name };
}

/**
 * Whether a value can be a caller's customer-id that takes a name: what the
 * router counts under its own name (1 to `CUSTOMER_ID_MAX_BYTES` bytes of
 * UTF-8, no control or format characters), and not a reserved value.
 */
export function isNameableCustomerId(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (utf8Bytes(value) > CUSTOMER_ID_MAX_BYTES) return false;
  if (ID_INVISIBLE.test(value)) return false;
  return !(UNNAMEABLE_CUSTOMERS as readonly string[]).includes(value);
}

/** One customer-id the routers counted or an admin named. */
export interface CustomerRow {
  id: string;
  name: string | null;
  /** Requests counted under it over `CustomersResponse.window`; null when the store did not answer or never counted it. */
  requests: number | null;
  /** When its name last changed, ISO UTC; null when it has none. */
  changedAt: string | null;
}

/** `GET /api/customers`: every id counted in the window or named, busiest first. */
export interface CustomersResponse {
  window: "24h";
  customers: CustomerRow[];
  /** The metrics store did not answer: only named ids are listed, without counts. */
  requestsUnavailable: boolean;
}

/** `GET /api/customers/names`: id → name, for every named id. */
export interface CustomerNamesResponse {
  names: Record<string, string>;
}

/** `POST /api/customers/name`: give `customer` a name, or clear it with `name: null`. */
export interface CustomerNameRequest {
  customer: string;
  name: string | null;
}
