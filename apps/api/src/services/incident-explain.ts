/**
 * Explain one incident the way this team already explains them in Slack.
 *
 * The alert that fires today posts a chain, a failure count and a list of
 * failed GUIDs, and nothing else — so someone has to go and read logs, and the
 * question that comes back within the hour is always Yuval's: "did you find out
 * if it's our issue or providers? Any next steps?". This writes the answer.
 *
 * ## The house style is not invented here, it is copied
 *
 * Idan's write-ups in #updates-gk8 have a fixed shape, and it is a good one:
 *
 *   In short:
 *   • This is the same recurring Stellar/Tatum issue again.
 *   • There were 6 failures out of 3,310 requests, which is 0.18%.
 *   • All 6 were POST /transactions.
 *   • Tatum was the only eligible provider.
 *   • The Router sent the transactions to Tatum, but Tatum did not return a
 *     response within 7 seconds.
 *   • Because these are stateful transactions, the Smart Router intentionally
 *     does not automatically retry them.
 *   • No backup provider was available, so all 6 requests failed completely.
 *   Conclusion: Tatum was slow again, and the combination of a 7-second
 *   timeout, a single eligible provider, and no automatic retry for stateful
 *   transactions continues to create customer failures.
 *
 * The bullets walk a CAUSAL CHAIN in order — what failed, what the router did
 * to save it, what still failed, and why the save did not work — and the last
 * of those is the part that keeps recurring: not "Tatum was slow" but "Lava is
 * not configured for debug on Fantom, so after Tatum failed nothing was
 * eligible". A summary that stops at "Tatum was slow" is the one nobody can
 * act on.
 *
 * `steps` is therefore ordered and numbered, and the prompt is told to stop
 * when the chain is told rather than to fill a quota.
 */
import type { Incident } from "@sr/shared";
import type { ErrorGroup } from "./loki.js";
import { BedrockService, type BedrockLogger } from "./bedrock.js";

export interface IncidentExplanation {
  incidentId: string;
  /** The causal chain, in order. Rendered as a numbered list. */
  steps: string[];
  /** One line naming the compound cause. The team's "Conclusion:" line. */
  conclusion: string;
  /** Whose problem, in the page's vocabulary. */
  owner: "provider" | "setup" | "caller" | "chain" | "undetermined";
}

const OWNERS = ["provider", "setup", "caller", "chain", "undetermined"] as const;

export interface IncidentExplainInputs {
  incident: Incident;
  /** Real error lines for the episode's window, grouped by fault. */
  errorGroups: ErrorGroup[];
  /** Providers configured on this chain, and their role. Empty without a values file. */
  configured: { upstream: string; role: "primary" | "backup" | null; addons: string[] }[];
}

const SYSTEM_PROMPT = `You write up one incident for the engineers running the Magma Devs Smart
Router, in the style their team already uses.

The router sits in front of raw blockchain RPC endpoints. For one client
request it picks an upstream provider, relays, and may retry or hedge to
another. Chains are Lava spec indexes (ETH1, SOLANA, FTM250). "Provider",
"upstream" and "endpoint" all mean the node the router relays TO.

## The shape, copied from how this team writes

Numbered steps that walk the CAUSAL CHAIN in order, then one conclusion line.
A real example of theirs:

  1. There were 6 failures out of 3,310 requests, which is 0.18%.
  2. All 6 were POST /transactions.
  3. Tatum was the only eligible provider.
  4. The Router sent the transactions to Tatum, but Tatum did not return a
     response within 7 seconds.
  5. Because these are stateful transactions, the Smart Router intentionally
     does not automatically retry them.
  6. No backup provider was available, so all 6 requests failed completely.
  Conclusion: Tatum was slow again, and the combination of a 7-second timeout,
  a single eligible provider, and no automatic retry for stateful transactions
  continues to create customer failures.

Read what that does. It names the provider. It gives exact counts and the
share. It names the method. Then it walks what the router DID, and — the part
that matters most — why the save did not work. Their other write-ups do the
same: "Lava is not configured as supporting debug on Fantom, so after Tatum
failed no alternative provider was eligible."

That last kind of step is the one people act on. "Tatum was slow" is not
actionable; "Tatum was slow AND nothing else was eligible" is.

## Rules

Plain language. Say "did not answer within the timeout", not "exhibited
latency degradation". Write for someone who will paste it into Slack.

Exact numbers from the input, never rounded into vagueness. If you have both a
failure count and a total, give the share as they do.

**Stop when the chain is told.** Four clear steps beat eight padded ones.
There is no quota. Do not add a step that only restates the one above it.

Only what the input establishes. If the config does not say why the failover
did not work, do not guess a reason — say the input does not show it. Absence
of a log line means the router did not record that fact; it never means the
thing did not happen.

Do not recommend fixes. Name what happened and whose it is, then stop. The
conclusion line names the compound cause, the way theirs does — usually more
than one thing had to be true at once.

## Your answer

Reply with ONLY a JSON object, no prose around it, no markdown fence:

{
  "steps": ["one step per string, in causal order"],
  "conclusion": "One line. The compound cause.",
  "owner": "provider|setup|caller|chain|undetermined"
}`;

/** Constrain the owner to the closed set. */
export function toOwner(raw: unknown): IncidentExplanation["owner"] {
  return typeof raw === "string" && (OWNERS as readonly string[]).includes(raw)
    ? (raw as IncidentExplanation["owner"])
    : "undetermined";
}

export function digestIncident(i: IncidentExplainInputs): string {
  const mins = Math.max(1, Math.round((i.incident.endUnix - i.incident.startUnix) / 60));
  return JSON.stringify(
    {
      chain: { spec: i.incident.spec, name: i.incident.chainName },
      window: { minutes: mins, ongoing: i.incident.ongoing },
      finalCustomerFailures: i.incident.failures,
      recoveredByRetry: i.incident.retriesRecovered,
      providersFailing: i.incident.blamed.map((b) => ({
        upstream: b.upstream,
        role: b.role,
        shareOfItsRelaysThatFailed: b.failRate,
      })),
      failedMethods: i.incident.failedMethods.map((m) => ({
        method: m.method,
        count: m.count,
        errorName: m.errorName,
        example: m.example,
      })),
      errorsFromLogs: i.errorGroups.map((g) => ({
        code: g.errorName,
        count: g.count,
        methods: g.methods.slice(0, 5),
        example: g.example,
      })),
      // The config is what answers "why did failover not save it" — which
      // provider could have taken over, and what each one is declared to serve.
      providersConfiguredOnThisChain: i.configured,
      capabilityGapTheConfigProves: i.incident.capabilityGap,
    },
    null,
    1,
  );
}

export class IncidentExplainService {
  constructor(
    private readonly bedrock: BedrockService,
    private readonly logger?: BedrockLogger,
  ) {}

  async explain(inputs: IncidentExplainInputs): Promise<IncidentExplanation> {
    const answer = await this.bedrock.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: digestIncident(inputs) }],
      // One incident, a handful of steps. Short by construction.
      maxTokens: 1500,
    });

    const start = answer.text.indexOf("{");
    const end = answer.text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("model did not return JSON");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(answer.text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      throw new Error("model did not return JSON");
    }

    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.filter((s): s is string => typeof s === "string" && s.trim() !== "")
      : [];
    if (steps.length === 0) {
      // No chain is not a short answer, it is no answer — and rendering an
      // empty numbered list under an incident reads as the feature being broken.
      this.logger?.warn({ incidentId: inputs.incident.id }, "incident explanation had no steps");
      throw new Error("model returned no steps");
    }

    return {
      incidentId: inputs.incident.id,
      steps,
      conclusion: typeof parsed.conclusion === "string" ? parsed.conclusion : "",
      owner: toOwner(parsed.owner),
    };
  }
}
