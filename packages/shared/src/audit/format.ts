/**
 * How a value is written into the audit log.
 *
 * **Redaction happens here, on the way in.** "No secret or node URL appears as a
 * value in the log, the export, or the API" is a promise across three read
 * paths, and a redact-on-read design keeps it only until one call site forgets.
 * So values are formatted and redacted by the writer and stored that way: there
 * is no un-redacted copy in the table, and therefore nothing to leak.
 *
 * The approve screen in MAG-2731 *does* show full values including node URLs —
 * an approver cannot do the job otherwise. That screen reads the pending-change
 * record, which is a different table. It must never be pointed at this one.
 *
 * The rules themselves are MAG-2770's, quoted:
 *
 *   - A list is written in a stable order, comma separated: `Alchemy, QuickNode`.
 *   - Empty is `(none)`, not blank — so a removal reads `Alchemy, QuickNode ->
 *     (none)` and nobody wonders whether the field was skipped.
 *   - On or off is `yes` / `no`.
 *   - A secret or a node URL is `(changed)`, or `(changed, ends a91f)`. Never
 *     the value itself.
 *   - A newly created thing has `from` = `(new)`. A deleted one has `to` =
 *     `(deleted)`.
 */

/** An empty value. Never a blank string — blank reads as "field skipped". */
export const AUDIT_NONE = "(none)";

/** The `from` side of a field on something that has just been created. */
export const AUDIT_NEW = "(new)";

/** The `to` side of a field on something that has just been deleted. */
export const AUDIT_DELETED = "(deleted)";

/** A redacted value with no suffix worth showing. */
export const AUDIT_CHANGED = "(changed)";

/**
 * One changed field, as stored. `from` and `to` have already been through the
 * helpers below — a raw value must never reach this type.
 */
export interface AuditChange {
  field: string;
  from: string;
  to: string;
}

/**
 * A secret's suffix is only shown when the value is long enough that four
 * characters are not a meaningful fraction of it. Below this, `(changed)`.
 */
const MIN_LENGTH_FOR_SUFFIX = 8;

/** How many trailing characters a redacted value may reveal. */
const SUFFIX_LENGTH = 4;

/**
 * A scalar, as text. Null, undefined and blank all become `(none)`.
 *
 * Not for secrets — see `auditSecret`. This is for the values that are safe to
 * read back: a name, a chain, an interface, a role.
 */
export function auditText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return AUDIT_NONE;
  const text = String(value).trim();
  return text === "" ? AUDIT_NONE : text;
}

/** On or off. */
export function auditFlag(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return AUDIT_NONE;
  return value ? "yes" : "no";
}

/**
 * A set of values, comma separated.
 *
 * Sorted and de-duplicated, because the point of a "stable order" is that the
 * same set written twice produces the same string — otherwise reordering looks
 * like a change and a real change hides among the noise. Sorted by code point
 * rather than `localeCompare`, so the ordering does not depend on the server's
 * locale.
 */
export function auditList(values: readonly (string | null | undefined)[] | null | undefined): string {
  if (!values) return AUDIT_NONE;
  const cleaned = [...new Set(values.map((v) => (v ?? "").trim()).filter((v) => v !== ""))];
  if (cleaned.length === 0) return AUDIT_NONE;
  cleaned.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return cleaned.join(", ");
}

/**
 * A secret, an API key, a credential or a node URL.
 *
 * Returns `(changed)`, or `(changed, ends a91f)` when the value is long enough
 * for a suffix to identify it without revealing it. Never returns any other part
 * of the input.
 *
 * Call this for *both* sides of the diff, with both values — the suffixes are
 * what let a reader tell "the URL was rotated" from "the URL was re-saved
 * unchanged", which is the only thing the row can honestly say about it.
 */
export function auditSecret(value: string | null | undefined): string {
  if (value === null || value === undefined) return AUDIT_NONE;
  const text = String(value).trim();
  if (text === "") return AUDIT_NONE;
  if (text.length < MIN_LENGTH_FOR_SUFFIX) return AUDIT_CHANGED;
  return `${AUDIT_CHANGED.slice(0, -1)}, ends ${text.slice(-SUFFIX_LENGTH)})`;
}

/**
 * True when a string is one of the redaction markers rather than a real value.
 *
 * Used by the writer's assertion that nothing raw slipped into a change row,
 * and by the viewer to render markers in a muted style rather than as content.
 */
export function isAuditMarker(value: string): boolean {
  return (
    value === AUDIT_NONE ||
    value === AUDIT_NEW ||
    value === AUDIT_DELETED ||
    value === AUDIT_CHANGED ||
    /^\(changed, ends .{1,16}\)$/.test(value)
  );
}

/**
 * Build a change entry, dropping it when nothing actually changed.
 *
 * A no-op field on a save is noise: it pads a row with lines a reader has to
 * scan past to find the field that moved. Returns `null` when `from` and `to`
 * are identical, so callers can `.filter(Boolean)` a whole form's worth of
 * fields and keep only what moved.
 */
export function auditChange(field: string, from: string, to: string): AuditChange | null {
  if (from === to) return null;
  return { field, from, to };
}
