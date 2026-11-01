/**
 * Does `value` look like an email address: one `@` with something before it,
 * and a domain with a dot that is neither its first nor its last character,
 * no whitespace anywhere. Deliverability is not checked.
 *
 * Not a regular expression on purpose. The usual one-liner,
 * `^[^\s@]+@[^\s@]+\.[^\s@]+$`, lets the dot be matched either side of the
 * `\.`, so a long run of dots backtracks polynomially — and this runs on what a
 * caller typed. Two index lookups and a scan are linear.
 */
export function looksLikeEmail(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}
