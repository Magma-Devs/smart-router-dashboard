/** What an Ask log line says about a failure. */
export interface AskErrorFields {
  /** The thrown error's class, or the thrown value's type. */
  errorClass: string;
  /** The class of the deepest error on its `cause` chain. */
  causeClass?: string;
  /** The deepest `code` on that chain: a Node code such as `ECONNREFUSED`, a
   * Postgres SQLSTATE such as `57P01`, or an `ASK_*` code. */
  errorCode?: string;
}

const CLASS = /^[A-Za-z_$][\w$]{0,63}$/;
const CODE = /^[A-Z0-9_]{2,64}$/;
const MAX_DEPTH = 8;

function className(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && CLASS.test(name) ? name : "object";
}

/**
 * Names a failure for a log line by its class and code alone. The ORM wraps
 * every query failure as `Failed query: <sql>` with the driver's error on
 * `cause`, and a driver's message can carry the connection string, so no
 * message, query or parameter is ever read here.
 */
export function askErrorFields(error: unknown): AskErrorFields {
  const fields: AskErrorFields = { errorClass: className(error) };
  let current = error;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (current === null || typeof current !== "object") break;
    if (current !== error) fields.causeClass = className(current);
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === "string" && CODE.test(code)) fields.errorCode = code;
    current = (current as { cause?: unknown }).cause;
  }
  return fields;
}
