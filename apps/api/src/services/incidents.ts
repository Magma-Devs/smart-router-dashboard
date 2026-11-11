/**
 * Customer-reported incidents: everything between a validated report and our
 * on-call system, apart from the route so it is testable without HTTP.
 *
 * A report goes to this deployment's own inbound webhook in Grafana IRM, an
 * integration of type `formatted_webhook`. Three things that webhook does shape
 * what is sent (grafana/oncall `engine/config_integrations/formatted_webhook.py`):
 *
 *  - Alerts are grouped by `alert_uid`. One whose uid matches an alert group
 *    that is still open joins it: no new escalation, no second call.
 *  - A group resolves only on `state: "ok"`, which this never sends. People
 *    resolve these; a report is not something that recovers by itself.
 *  - A 2xx means the alert was QUEUED. IRM routes it and places the call after
 *    answering, so "accepted" is all a 200 from here may claim.
 *
 * What each severity then does is decided by the integration's routes, not
 * here. See `docs/INCIDENTS.md`.
 */
import { INCIDENT_SEVERITY_LABELS, type IncidentSeverity, type Role } from "@sr/shared";

/**
 * The IRM grouping key for a report.
 *
 * **Critical shares one key per clock hour (UTC).** The first Critical in an
 * hour opens an alert group and calls the on-call; any further Critical that
 * hour joins that group instead of calling again. Without it, a Critical form
 * that anyone can reach is a button that rings the rota as often as it is
 * pressed. A new hour opens a new group, so a group nobody resolved cannot
 * swallow reports for longer than that — and once the on-call resolves it, the
 * next Critical calls again straight away.
 *
 * **Everything else is keyed on the form's own id**, so a retry after a timeout
 * joins the report it repeats rather than filing a second one.
 */
export function incidentAlertUid(severity: IncidentSeverity, id: string, now: Date): string {
  return severity === "critical" ? `critical-${now.toISOString().slice(0, 13)}` : `report-${id}`;
}

// Every C0/C1 control character except tab and newline, and the bidi
// overrides: none can be typed into the form, and in a message they only ever
// hide text or show it in an order other than the one it was written in.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** A one-line title: no control characters at all, runs of whitespace as one space. */
export function cleanIncidentTitle(raw: string): string {
  return raw.replace(CONTROL, "").replace(/\s+/g, " ").trim();
}

/** A free-text field: line breaks kept (as `\n`), other control characters
 *  dropped, at most one blank line in a row. */
export function cleanIncidentText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface IncidentReporterContext {
  name: string;
  email: string;
  phone: string | null;
  /** True when the reporter is the signed-in user (AUTH_MODE=enabled), false
   *  when the name and address were typed into the form and nobody checked them. */
  signedIn: boolean;
  role: Role | null;
}

export interface IncidentContext {
  id: string;
  severity: IncidentSeverity;
  title: string;
  description: string | null;
  chain: string | null;
  routerId: string | null;
  reporter: IncidentReporterContext;
  dashboardVersion: string;
  receivedAt: Date;
}

/** The body the incident view in IRM reads, as plain text. */
export function renderIncidentMessage(ctx: IncidentContext): string {
  const r = ctx.reporter;
  const who = [`${r.name} <${r.email}>`, r.phone].filter(Boolean).join(" · ");
  const how = r.signedIn ? `signed in${r.role ? `, ${r.role}` : ""}` : "typed into the form, not verified";
  const scope = [ctx.chain && `Chain: ${ctx.chain}`, ctx.routerId && `Router: ${ctx.routerId}`].filter(Boolean);
  return [
    ctx.description ?? "(no description)",
    "",
    `Severity: ${INCIDENT_SEVERITY_LABELS[ctx.severity]}`,
    ...(scope.length > 0 ? [scope.join(" · ")] : []),
    `Reported by: ${who} (${how})`,
    `Reported at: ${ctx.receivedAt.toISOString()}`,
    `Incident id: ${ctx.id}`,
    `Dashboard: ${ctx.dashboardVersion}`,
  ].join("\n");
}

/**
 * The `formatted_webhook` payload.
 *
 * `alert_uid`, `title`, `state` and `message` are the fields the integration
 * understands; the rest are carried for its routes and templates, which read
 * `payload.severity` to decide who hears about it. Deliberately absent:
 * `link_to_upstream_details` and `image_url`, which IRM turns into links. With
 * accounts off the report can come from anyone, and a link it chose would be
 * one click away from the on-call.
 */
export function buildIrmPayload(ctx: IncidentContext): Record<string, unknown> {
  return {
    alert_uid: incidentAlertUid(ctx.severity, ctx.id, ctx.receivedAt),
    title: `[${INCIDENT_SEVERITY_LABELS[ctx.severity]}] ${ctx.title}`,
    state: "alerting",
    message: renderIncidentMessage(ctx),
    severity: ctx.severity,
    incident_id: ctx.id,
    reported_at: ctx.receivedAt.toISOString(),
    chain: ctx.chain,
    router_id: ctx.routerId,
    reporter: {
      name: ctx.reporter.name,
      email: ctx.reporter.email,
      phone: ctx.reporter.phone,
      signed_in: ctx.reporter.signedIn,
      role: ctx.reporter.role,
    },
    dashboard_version: ctx.dashboardVersion,
  };
}

export type IrmDelivery =
  | { ok: true; status: number }
  | { ok: false; status: number | null; reason: "refused" | "timeout" | "unreachable" };

/**
 * POST the payload. Never throws, and never puts the URL in what it returns —
 * the URL is the credential, so it must not reach a log line or an error.
 */
export async function sendToIrm(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<IrmDelivery> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // IRM answers "Ok." as text; nothing in the body is needed either way.
    await res.text().catch(() => undefined);
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, reason: "refused" };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, status: null, reason: timedOut ? "timeout" : "unreachable" };
  }
}

/**
 * How many reports this process may send in a sliding window, from every
 * caller together.
 *
 * IRM caps alerts at 300 per 5 minutes per integration and 900 per 5 minutes
 * per organisation (`apps/integrations/mixins/ratelimit_mixin.py`), and that
 * organisation budget is the one our own fleet alerts are delivered on. A flood
 * of reports through one dashboard must never be able to spend it, so this
 * refuses well short of it. The per-caller limit cannot do that alone: callers
 * change address for free.
 *
 * Per process, not per deployment: the chart runs one api per node, so a
 * deployment's ceiling is this times its node count.
 */
export class ReportBudget {
  private readonly sent: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Spend one slot if there is one. */
  take(now: number = Date.now()): boolean {
    while (this.sent.length > 0 && this.sent[0]! <= now - this.windowMs) this.sent.shift();
    if (this.sent.length >= this.max) return false;
    this.sent.push(now);
    return true;
  }
}
