/** The most names one read's result carries. */
export const MAX_NAMES_PER_READ = 50;

/** What the `customerNames` field costs a result beside its entries: the key and the braces. */
const FIELD_BYTES = Buffer.byteLength(',"customerNames":{}');

/**
 * The names of the customer-ids a read's result holds under the `customer`
 * key: a series label or a JSON field (`"customer":"<id>"`), or such a field
 * inside a log line (`\"customer\":\"<id>\"`). Entries are added while they
 * fit `maxBytes`, so the field never pushes a result past its limit.
 * Undefined when there is none, so the result gains no field.
 */
export function namesIn(
  payload: string,
  names: ReadonlyMap<string, string>,
  maxBytes = Number.POSITIVE_INFINITY,
): Record<string, string> | undefined {
  const found: Record<string, string> = {};
  let count = 0;
  let bytes = FIELD_BYTES;
  for (const [id, name] of names) {
    if (count >= MAX_NAMES_PER_READ) break;
    const field = `"customer":${JSON.stringify(id)}`;
    if (!payload.includes(field) && !payload.includes(JSON.stringify(field).slice(1, -1))) continue;
    const entry = Buffer.byteLength(`${JSON.stringify(id)}:${JSON.stringify(name)},`);
    if (bytes + entry > maxBytes) break;
    found[id] = name;
    bytes += entry;
    count++;
  }
  return count ? found : undefined;
}
