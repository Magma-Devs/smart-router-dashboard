/**
 * Read the whole Status report at once and say what is actually going on.
 *
 * The page already explains each row well. What no row can do is look across
 * all four tabs: the same provider surfaces as an Issue on one chain, an
 * Insight on another and the blamed party inside an Incident, and nothing
 * joins them. That join is the job here — group, rank, and say the one thing
 * an operator should take away. It is a correlation problem, not a writing
 * problem, so the model is given findings that are ALREADY worded and asked
 * to relate them, never to describe them again.
 *
 * ## The honesty contract, enforced rather than requested
 *
 * The page's rule is that every number maps to a real metric and anything
 * unmeasured says so. A model cannot be trusted to keep that by being asked
 * nicely, so every theme must cite the finding ids it rests on, and
 * `dropUncited()` deletes any that cites nothing real before the page ever
 * sees it. A hallucinated provider has nothing to cite, so it does not render.
 *
 * `notDetermined` is borrowed from the Relay Investigator (PR #163): somewhere
 * honest for the model to put what it could not tell, so it never fills a gap
 * with a plausible guess. Nothing renders it; it exists to absorb the pressure
 * to sound complete.
 */
import type { Incident, StatusReport } from "@sr/shared";
import { BedrockService, type BedrockLogger } from "./bedrock.js";

/**
 * The answer hit the output ceiling, so the JSON is cut mid-object.
 *
 * Its own type because the fix is different: raise `maxTokens`, or narrow the
 * window so fewer findings go in. Reported as a truncation rather than as
 * "the model said something unparseable", which would send whoever reads it
 * looking at the prompt.
 */
export class StatusAiTruncated extends Error {
  constructor(readonly outputTokens: number | null) {
    super("the brief was cut off at the token ceiling");
    this.name = "StatusAiTruncated";
  }
}

/** One correlated theme — several findings that share a cause. */
export interface StatusTheme {
  title: string;
  /** Two or three sentences. What is happening and whose side it is on. */
  detail: string;
  severity: "critical" | "degraded" | "advisory";
  /** Finding ids this rests on. Validated against the report; never trusted. */
  findingIds: string[];
}

export interface StatusAnalysis {
  /** One sentence: the state of the deployment right now. */
  headline: string;
  themes: StatusTheme[];
  /** Forwardable to the customer as-is, or null when there is nothing to send. */
  customerMessage: string | null;
  /** Themes the model produced that cited nothing real, and were dropped. */
  droppedUncited: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

const SYSTEM_PROMPT = `You brief engineers operating the Magma Devs Smart Router.

## What the router is

It sits in front of raw blockchain RPC endpoints and multiplexes across them.
For one client request it picks an upstream provider, relays the request, and
may retry, hedge to a second provider, serve from cache, or cross-validate
answers between providers. Chains are identified by a Lava spec index (ETH1,
SOLANA, BASE, AVALANCHEC, ...). "Provider", "upstream" and "endpoint" all mean
the node the router relays TO.

## What you are given

A Status report that has ALREADY been computed and worded from Prometheus
counters, the router's logs and the mounted config. Findings, insights,
incidents and per-chain rows, each with a stable id.

Every one of those rows is already explained on the page. Do not restate them.

## Your job

Relate them. One provider can appear as an Issue on one chain, an Insight on
another and the blamed party inside an Incident, and nothing on the page joins
those up. That join is what you add:

- Group findings that share a cause — the same provider across chains, the same
  error code across findings, one incident explained by a config fact.
- Rank by what an operator should deal with first.
- Say whose problem each theme is: the provider's, the setup's, the caller's,
  or the chain's. The page's own vocabulary.

## Rules

Severity words are fixed by the page and you must not re-derive them: over 5%
of answers affected is critical, 1-5% is degraded, anything structural or
forward-looking is advisory. Use the tier already on the finding.

**Every theme must cite the finding ids it rests on.** A theme citing nothing is
deleted before anyone reads it, so a claim you cannot ground is wasted output.
Cite the ids exactly as given.

Never introduce a number, provider, chain or error code that is not in the input.
You are not being asked to analyse metrics — you are being asked to relate
conclusions that were already drawn. If two findings might share a cause but the
input does not establish it, say "may share" or leave it out.

Do not recommend actions. The page states the issue and whose side it is on,
then stops; so do you. "chainstack is failing on three chains, not just this
one" is the job. "Contact chainstack" is not.

Do not report successes. Absence of findings means no rule crossed, never a
clean bill of health. If the report is empty, say so plainly in one line and
return no themes.

A short honest brief is worth more than a complete-sounding one. Two real
themes beat six padded ones.

## Your answer

Reply with ONLY a JSON object, no prose around it, no markdown fence:

{
  "headline": "One sentence. The state of the deployment right now.",
  "themes": [
    {
      "title": "short",
      "detail": "two or three sentences",
      "severity": "critical|degraded|advisory",
      "findingIds": ["id", "id"]
    }
  ],
  "customerMessage": "A paragraph forwardable to the customer as-is, or null when there is nothing worth sending.",
  "notDetermined": ["things the report could have established and did not"]
}

notDetermined is for you, not the reader — somewhere honest to put what you
could not tell, so you never fill a gap in a theme with a guess. Nothing
renders it. Empty is a fine and common answer. Do not put things that are
unknowable in principle there: what a provider that was never asked would have
answered is not a reporting gap.`;

/**
 * What the model is shown. Deliberately NOT the whole report: the per-chain
 * rows and the evidence pairs are the page's detail view, and feeding them
 * costs tokens while inviting the model to restate rather than relate.
 */
function digest(report: StatusReport, incidents: Incident[]): string {
  return JSON.stringify(
    {
      window: { computedAtUnix: report.computedAtUnix },
      totals: report.totals,
      lastCritical24h: report.lastCritical24h,
      worstMover: report.worstMover,
      findings: report.findings.map((f) => ({
        id: f.id,
        tier: f.tier,
        kind: f.kind,
        spec: f.spec,
        chain: f.chainName,
        upstream: f.upstream,
        role: f.role,
        headline: f.headline,
        metric: `${f.metric.value} ${f.metric.label}`,
        codes: f.codes,
        ongoing: f.ongoing,
      })),
      insights: report.insights.map((i) => ({
        id: `insight:${i.kind}:${i.spec}:${i.upstream ?? ""}`,
        tier: i.tier,
        kind: i.kind,
        spec: i.spec,
        chain: i.chainName,
        upstream: i.upstream,
        headline: i.headline,
        value: i.value,
        baseline: i.baseline,
      })),
      incidents: incidents.map((i) => ({
        id: i.id,
        spec: i.spec,
        chain: i.chainName,
        ongoing: i.ongoing,
        failures: i.failures,
        retriesRecovered: i.retriesRecovered,
        blamed: i.blamed.map((b) => ({ upstream: b.upstream, role: b.role, failRate: b.failRate })),
        capabilityGap: i.capabilityGap,
        story: i.story,
      })),
      chainsWithoutFailover: report.noFailover.map((c) => c.spec),
    },
    null,
    1,
  );
}

/** Every id the model is allowed to cite. */
function citableIds(report: StatusReport, incidents: Incident[]): Set<string> {
  const ids = new Set<string>();
  for (const f of report.findings) ids.add(f.id);
  for (const i of report.insights) ids.add(`insight:${i.kind}:${i.spec}:${i.upstream ?? ""}`);
  for (const i of incidents) ids.add(i.id);
  return ids;
}

/**
 * Delete themes that cite nothing real, and prune ids that do not exist.
 *
 * This is the enforcement the honesty contract needs: a theme about a provider
 * the report never mentioned has no id to cite, so it cannot survive. Asking
 * the model to be careful is not a control; this is.
 */
export function dropUncited(
  themes: StatusTheme[],
  valid: Set<string>,
): { kept: StatusTheme[]; dropped: number } {
  const kept: StatusTheme[] = [];
  let dropped = 0;
  for (const t of themes) {
    const ids = (t.findingIds ?? []).filter((id) => valid.has(id));
    if (ids.length === 0) {
      dropped += 1;
      continue;
    }
    kept.push({ ...t, findingIds: ids });
  }
  return { kept, dropped };
}

/** Pull the JSON object out of a reply, tolerating a stray fence. */
export function parseAnswer(text: string): {
  headline?: unknown;
  themes?: unknown;
  customerMessage?: unknown;
} | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class StatusAiService {
  constructor(
    private readonly bedrock: BedrockService,
    private readonly logger?: BedrockLogger,
  ) {}

  /**
   * One brief over the whole report. Throws `BedrockError` when the model
   * cannot be reached — a half-read report must not become a confident brief.
   */
  async analyse(report: StatusReport, incidents: Incident[]): Promise<StatusAnalysis> {
    const answer = await this.bedrock.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: digest(report, incidents) }],
      // Sized for the worst case, not the typical one. Measured on GK8: a
      // 12-finding report answers in ~1400 tokens, but the ceiling has to
      // clear a bad day — 31 chains all with findings — because a cut-off
      // answer is unparseable JSON rather than a shorter brief. Billing is on
      // tokens actually produced, so the headroom is free unless it is used.
      maxTokens: 8000,
    });

    // Truncation and refusal are different problems with different fixes, and
    // "did not return JSON" describes both while helping with neither.
    if (answer.stopReason === "max_tokens") {
      this.logger?.warn({ outputTokens: answer.outputTokens }, "status ai answer hit the token ceiling");
      throw new StatusAiTruncated(answer.outputTokens);
    }

    const parsed = parseAnswer(answer.text);
    if (!parsed) {
      this.logger?.warn(
        { stopReason: answer.stopReason, text: answer.text.slice(0, 400) },
        "status ai returned unparseable json",
      );
      throw new Error("model did not return JSON");
    }

    const rawThemes: StatusTheme[] = Array.isArray(parsed.themes)
      ? (parsed.themes as StatusTheme[]).filter((t) => t && typeof t.title === "string")
      : [];
    const { kept, dropped } = dropUncited(rawThemes, citableIds(report, incidents));
    if (dropped > 0) {
      // Worth a log line: a model inventing themes is a prompt problem, and
      // this is the only place it is visible.
      this.logger?.warn({ dropped }, "status ai themes cited nothing in the report");
    }

    return {
      headline: typeof parsed.headline === "string" ? parsed.headline : "",
      themes: kept,
      customerMessage: typeof parsed.customerMessage === "string" ? parsed.customerMessage : null,
      droppedUncited: dropped,
      model: "",
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
    };
  }
}
