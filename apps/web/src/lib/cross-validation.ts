import type { CallFacts } from "@sr/shared";

/**
 * What the Outvoted row's counts are, after the names: every case the
 * router's per-provider disagreement counter takes in, which it does not
 * tell apart.
 */
export const OUTVOTED_MEANS = "their answer was not the one the router returned - it differed, it was an error, or no answer was agreed on";

/** One chip of a failed cross-validation's rule: a few words and how to colour them. */
export interface QuorumChip {
  text: string;
  tone: "plain" | "warn" | "bad";
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The rule a request failed, as chips, in the order a reader asks: what the
 * rule wanted, how many providers answered, how many of those agreed.
 * "2 of 3 must agree" where the router says how many providers the rule
 * asks, "2 must agree" where it doesn't. The last chip is drawn only where
 * the router counted the answers that agreed, and two or more answered: with
 * one answer there was nothing to compare, and the "answered" chip says so.
 */
export function quorumChips(q: NonNullable<CallFacts["quorum"]>): QuorumChip[] {
  const chips: QuorumChip[] = [
    { text: q.asked != null && q.asked >= q.needed ? `${q.needed} of ${q.asked} must agree` : `${q.needed} must agree`, tone: "plain" },
    { text: `${q.answered} answered`, tone: q.answered < q.needed ? "warn" : "plain" },
  ];
  if (q.nodeErrors > 0) chips.push({ text: `${count(q.nodeErrors, "provider", "providers")} returned an error`, tone: "warn" });
  if (q.agreed != null && q.answered >= 2) {
    chips.push({ text: q.agreed <= 1 ? "No two agreed" : `Only ${q.agreed} agreed`, tone: "bad" });
  }
  return chips;
}

/**
 * How far the block a request asked for was from the router's latest block.
 * Behind it is marked (`warn`, orange): providers a few blocks apart answer
 * an old block differently less often than a new one, so the distance is the
 * first thing to read. Ahead of it is `bad` (red): the request named a block
 * the router had not seen yet. The same block carries no colour.
 */
export function blockOffHead(asked: number, head: number, fmt: (n: number) => string = String): { text: string; tone: "plain" | "warn" | "bad" } {
  const d = asked - head;
  if (d === 0) return { text: "the same block", tone: "plain" };
  const blocks = `${fmt(Math.abs(d))} ${Math.abs(d) === 1 ? "block" : "blocks"}`;
  return d < 0 ? { text: `${blocks} behind`, tone: "warn" } : { text: `${blocks} ahead`, tone: "bad" };
}
