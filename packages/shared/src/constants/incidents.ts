/**
 * Customer-reported incidents: the four severities a report can carry, and the
 * limits on what a report may say.
 *
 * The severity decides what reaches our engineers, and that decision is made in
 * our on-call system, not here — the dashboard only forwards the word. What each
 * one does is still stated to the reporter, because "will somebody be woken up?"
 * is the question they are actually answering when they pick one:
 *
 * | | Calls the on-call | Alerts the team | Opens a ticket |
 * |---|---|---|---|
 * | `critical` | yes | yes | yes |
 * | `high`     | no  | yes | yes |
 * | `medium`   | no  | no  | yes |
 * | `low`      | no  | no  | yes |
 *
 * See `docs/INCIDENTS.md`.
 */
export const INCIDENT_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** One line each, shown beside the choice in the report dialog. Written for the
 *  reporter: what is wrong, and what reporting it sets in motion. */
export const INCIDENT_SEVERITY_DESCRIPTIONS: Record<IncidentSeverity, string> = {
  critical: "Production is down or failing for your users. Calls our on-call engineer, day or night.",
  high: "Badly degraded, but still serving. Alerts our engineering team straight away, without a call.",
  medium: "Something is wrong, and your users are still served. Opens a ticket for our engineers.",
  low: "A question or a minor issue. Opens a ticket for our engineers.",
};

/** What happens now, shown once the report has been accepted. */
export const INCIDENT_SEVERITY_NEXT: Record<IncidentSeverity, string> = {
  critical: "Our on-call engineer is being called now.",
  high: "Our engineering team has been alerted. Nobody is called.",
  medium: "A ticket is being opened for our engineers.",
  low: "A ticket is being opened for our engineers.",
};

/** True when `value` is one of the four severities. */
export function isIncidentSeverity(value: unknown): value is IncidentSeverity {
  return typeof value === "string" && (INCIDENT_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Field limits, shared so the form and the api refuse the same input.
 *
 * The description stops at 2000 because Slack cuts a message block at 2800
 * characters, and a report that arrives with its end missing is worse than one
 * the reporter was asked to shorten. The rest are column-shaped: 254 is the
 * RFC 5321 ceiling for an address.
 */
export const INCIDENT_LIMITS = {
  title: 120,
  description: 2000,
  name: 120,
  email: 254,
  phone: 40,
} as const;
