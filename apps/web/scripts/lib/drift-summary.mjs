/**
 * drift-summary.mjs — explain a method-catalog drift, not just list it.
 *
 * `check-spec-sync.mjs` compares the committed Try-it catalog with one
 * regenerated from live lava-specs. The catalog holds each spec's RESOLVED
 * surface — `imports` merged transitively — so a change to a base spec
 * (ETH1, COSMOSSDK50, …) moves every spec that imports it. Listing the 43
 * moved indices is true and useless: the reader has to work out that
 * ethereum.json changed. These helpers add the two things that make the
 * line actionable — what each spec gained or lost, and which imported base
 * spec the changed set has in common.
 *
 * Pure functions over parsed JSON; the check wires them to files.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Index every spec in a lava-specs checkout: index → { file, imports }.
 * Disabled base specs are included on purpose — they are exactly the ones
 * an attribution wants to name.
 */
export function loadSpecIndex(specsDir) {
  const out = new Map();
  for (const file of readdirSync(specsDir)) {
    if (!file.endsWith(".json")) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(path.join(specsDir, file), "utf8"));
    } catch {
      continue; // not a spec (package.json, tsconfig, …)
    }
    for (const spec of doc?.proposal?.specs ?? []) {
      if (!spec?.index) continue;
      out.set(String(spec.index).toUpperCase(), {
        file,
        imports: (spec.imports ?? []).map((i) => String(i).toUpperCase()),
      });
    }
  }
  return out;
}

/** Transitive `imports` closure of one index (cycle-safe, excludes itself). */
export function importClosure(index, specIndex, seen = new Set()) {
  for (const imp of specIndex.get(index)?.imports ?? []) {
    if (seen.has(imp)) continue;
    seen.add(imp);
    importClosure(imp, specIndex, seen);
  }
  return seen;
}

/**
 * Resolve one catalog entry to its method surface. Better than half the
 * catalog is stored as an alias — a bare string naming the index whose
 * surface this one shares — so a caller that reads `catalog[index]` gets
 * either `{ [iface]: { [tier]: [...] } }` or `"BTCS"`. Follows the alias
 * chain (cycle-safe) and returns `{}` for a dangling or circular one.
 */
export function resolveEntry(catalog, key, seen = new Set()) {
  let entry = catalog?.[key];
  while (typeof entry === "string") {
    if (seen.has(entry)) return {};
    seen.add(entry);
    entry = catalog?.[entry];
  }
  return entry && typeof entry === "object" ? entry : {};
}

/**
 * Count what changed inside one catalog entry. Entries are
 * `{ [iface]: { [tier]: [{ m, p?, d?, … }] } }`; a method is keyed by `m`
 * within its (iface, tier) slot. Pass resolved entries — an alias string
 * reaching here counts as an empty surface rather than throwing.
 */
export function diffMethodEntry(before, after) {
  const counts = { added: 0, removed: 0, changed: 0 };
  const shape = (e) => (e && typeof e === "object" ? e : {});
  const [x, y] = [shape(before), shape(after)];
  const slots = new Set();
  for (const src of [x, y]) {
    for (const [iface, tiers] of Object.entries(src)) {
      for (const tier of Object.keys(shape(tiers))) slots.add(`${iface} ${tier}`);
    }
  }
  const methods = (entry, iface, tier) => {
    const list = shape(entry[iface])[tier];
    return new Map(Array.isArray(list) ? list.map((m) => [m.m, m]) : []);
  };
  for (const slot of slots) {
    const [iface, tier] = slot.split(" ");
    const a = methods(x, iface, tier);
    const b = methods(y, iface, tier);
    for (const m of a.keys()) if (!b.has(m)) counts.removed += 1;
    for (const [m, entry] of b) {
      if (!a.has(m)) counts.added += 1;
      else if (JSON.stringify(a.get(m)) !== JSON.stringify(entry)) counts.changed += 1;
    }
  }
  return counts;
}

/**
 * Which imported base spec(s) every changed index has in common. A base
 * that is in the import closure of ALL changed specs (or is one of them and
 * in the closure of all the others) is the likely single cause.
 *
 * Returns `{ shared: [{ index, file }], covered: n }` — `covered` is how
 * many of the changed indices import at least one shared base.
 */
export function attributeToImports(changed, specIndex) {
  if (changed.length === 0) return { shared: [], covered: 0 };
  const closures = new Map(changed.map((i) => [i, importClosure(i, specIndex)]));
  const candidates = new Map(); // base → count of changed specs importing it
  for (const [i, closure] of closures) {
    for (const base of closure) candidates.set(base, (candidates.get(base) ?? 0) + 1);
    // A base that changed alongside its importers counts as its own cause.
    candidates.set(i, (candidates.get(i) ?? 0) + 1);
  }
  const shared = [...candidates]
    .filter(([, n]) => n === changed.length)
    .map(([index]) => ({ index, file: specIndex.get(index)?.file ?? "?" }))
    // Most specific shared base first (the one with the deepest ancestry).
    .sort(
      (x, y) => importClosure(y.index, specIndex).size - importClosure(x.index, specIndex).size,
    );
  const covered = changed.filter((i) =>
    shared.some((s) => s.index === i || closures.get(i).has(s.index)),
  ).length;
  return { shared, covered };
}

/**
 * Trailing note for a count line whose entry is, or was, an alias — a
 * `+0 -0 ~0` row is otherwise unreadable when only the alias string moved.
 */
function aliasNote(before, after) {
  const a = typeof before === "string" ? before : null;
  const b = typeof after === "string" ? after : null;
  if (a && b) return a === b ? "" : `  (alias ${a} → ${b})`;
  if (a) return `  (was an alias to ${a}, now its own entry)`;
  if (b) return `  (now an alias to ${b})`;
  return "";
}

/**
 * Lines for the "methods changed" section of the gate output. `before` and
 * `after` are the parsed catalogs; `specIndex` may be null when the specs
 * dir was not available (attribution is then skipped, counts still print).
 */
export function summarizeMethodDrift(before, after, specIndex, { max = 20 } = {}) {
  const changed = Object.keys(after).filter(
    (k) => k in before && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  if (changed.length === 0) return [];
  const lines = [`  methods changed (${changed.length}):`];
  for (const k of changed.slice(0, max)) {
    // Diff the resolved surfaces: an alias moving to another index, or
    // becoming an entry of its own, changes what the chain serves even
    // though only the alias string moved.
    const c = diffMethodEntry(resolveEntry(before, k), resolveEntry(after, k));
    lines.push(
      `    ${k.padEnd(14)} +${c.added} -${c.removed} ~${c.changed}${aliasNote(before[k], after[k])}`,
    );
  }
  if (changed.length > max) lines.push(`    … and ${changed.length - max} more`);
  if (specIndex) {
    const { shared } = attributeToImports(changed, specIndex);
    if (changed.length === 1) {
      const file = specIndex.get(changed[0])?.file ?? "?";
      lines.push(`    → ${changed[0]} changed in its own file (${file}).`);
    } else if (shared.length) {
      const named = shared.map((s) => `${s.index} (${s.file})`).join(", ");
      lines.push(
        `    → every changed spec is, or imports, ${named} — one base-spec change, not ${changed.length} unrelated ones.`,
        "      Nothing to curate: regenerate, skim the roll-call diff, commit.",
      );
    } else {
      lines.push("    → no import in common: these specs changed on their own.");
    }
  }
  return lines;
}
