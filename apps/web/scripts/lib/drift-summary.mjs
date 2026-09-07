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
 * Count what changed inside one catalog entry. Entries are
 * `{ [iface]: { [tier]: [{ m, p?, d?, … }] } }`; a method is keyed by `m`
 * within its (iface, tier) slot.
 */
export function diffMethodEntry(before, after) {
  const counts = { added: 0, removed: 0, changed: 0 };
  const slots = new Set();
  for (const src of [before, after]) {
    for (const [iface, tiers] of Object.entries(src ?? {})) {
      for (const tier of Object.keys(tiers ?? {})) slots.add(`${iface} ${tier}`);
    }
  }
  for (const slot of slots) {
    const [iface, tier] = slot.split(" ");
    const a = new Map((before?.[iface]?.[tier] ?? []).map((x) => [x.m, x]));
    const b = new Map((after?.[iface]?.[tier] ?? []).map((x) => [x.m, x]));
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
    const c = diffMethodEntry(before[k], after[k]);
    lines.push(`    ${k.padEnd(14)} +${c.added} -${c.removed} ~${c.changed}`);
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
