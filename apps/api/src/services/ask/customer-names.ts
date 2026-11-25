/** The most names one read's result carries. */
export const MAX_NAMES_PER_READ = 50;

/**
 * The names of the customer-ids a read's result holds as whole string values:
 * a label value or a JSON field (`"<id>"`), or such a field inside a log line
 * (`\"<id>\"`). Undefined when it holds none, so the result gains no field.
 */
export function namesIn(
  payload: string,
  names: ReadonlyMap<string, string>,
): Record<string, string> | undefined {
  const found: Record<string, string> = {};
  let count = 0;
  for (const [id, name] of names) {
    if (count >= MAX_NAMES_PER_READ) break;
    const quoted = JSON.stringify(id);
    if (payload.includes(quoted) || payload.includes(JSON.stringify(quoted).slice(1, -1))) {
      found[id] = name;
      count++;
    }
  }
  return count ? found : undefined;
}
