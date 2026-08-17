/**
 * CSV serialisation for exports.
 *
 * The member list is the artifact an auditor asks for first, and the audit log
 * export (MAG-2770) needs the identical treatment — so this lives in `shared`
 * rather than in either one.
 */

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than
 * text. A field starting with one of these gets a leading apostrophe.
 *
 * This matters because the file's primary consumer is Excel or Sheets, and the
 * content is attacker-controlled in places: people choose their own display
 * name and the local part of their address. Without the guard, a member called
 * `=HYPERLINK("http://evil","click")` executes when the auditor opens the file.
 *
 * Tab and CR are included because some parsers treat them as leading
 * whitespace and then re-examine the *next* character for a formula.
 */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Escape one field: neutralise a formula lead, then quote when the value holds
 * a delimiter, a quote, or a newline (doubling any embedded quote).
 *
 * The formula guard is deliberately **lossy** — it prepends a character that
 * was not in the data. That is the accepted trade for a file that opens in a
 * spreadsheet by default.
 */
export function escapeCsvField(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const guarded = FORMULA_LEAD.has(value[0] ?? "") ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * Serialise a header row plus data rows.
 *
 * CRLF line endings per RFC 4180 — Excel on Windows needs them or it collapses
 * every row into one cell, and every other parser accepts them. No trailing
 * newline.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): string {
  const lines = [headers.map(escapeCsvField).join(",")];
  for (const row of rows) lines.push(row.map(escapeCsvField).join(","));
  return lines.join("\r\n");
}
