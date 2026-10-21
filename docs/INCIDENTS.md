# Incident reports

MAG-4403. A **Report incident** button in the top bar lets a customer tell
Magma's engineers that something is wrong, with a severity, without leaving the
dashboard. The report goes to the deployment's own inbound webhook in our
on-call system (Grafana IRM), and IRM decides who hears about it.

Off by default. Everything below assumes `INCIDENTS_ENABLED=true`.

## Severities

| Severity | What the reporter is told | What happens |
|---|---|---|
| Critical | Production is down or failing for your users | The on-call engineer is called, then the next one if nobody answers |
| High | Badly degraded, but still serving | The engineering team is alerted in Slack; nobody is called |
| Medium | Something is wrong, users are still served | A ticket is opened |
| Low | A question or a minor issue | A ticket is opened |

The dashboard only forwards the word. The "what happens" column is the IRM
integration's routes and the ticket job, both in `smart-router-infrastructure`
(MAG-4405, MAG-4406). The words the reporter reads live in
`packages/shared/src/constants/incidents.ts`, and a test pins that only Critical
promises a call.

## Who may report

| `AUTH_MODE` | Reporter | Recorded |
|---|---|---|
| `disabled` | **Anyone who can reach the dashboard.** Name and email are required, phone is optional, all as typed and marked unverified in the report | IRM only — there is no audit log without accounts |
| `enabled` | The signed-in user, any role. A reporter in the body is ignored | IRM, plus an `incident.reported` audit row (actor, IP, client, session; the severity in the note) |

With accounts off this is open by design: the button is for customers whose
dashboard has no sign-in. The limits below bound what an open form can do.

## The path

```
browser ──POST /api/incidents──▶ api ──POST (formatted_webhook)──▶ IRM ──routes on payload.severity──▶ call / Slack / ticket
   ▲                               │
   └──── 200 {id, severity, sentAt} only after IRM answered 2xx
```

- **The button comes from the web container's env** (`INCIDENTS_ENABLED`), read
  by the `(app)` layout. A customer reports an incident exactly when something
  is broken, and the api may be part of it; the dialog still opens and says
  what went wrong.
- **A 200 means IRM accepted the report, nothing more.** IRM queues the alert
  and routes it after answering, so the dialog says the report "reached our
  on-call system". Any other outcome keeps the form and shows the error, and
  the same id goes with the next try.
- **Nothing in the report is turned into a link.** The payload carries no
  `link_to_upstream_details` and no `image_url`, which IRM renders as links:
  with accounts off, anyone could choose them.

### Payload

What the api sends, and what the IRM routes and templates may rely on:

| Field | Value |
|---|---|
| `alert_uid` | IRM's grouping key — see below |
| `title` | `[<Severity>] <title>`, free text from the reporter |
| `state` | always `alerting`; the group never resolves on its own |
| `message` | plain text: the description, then severity, scope, reporter, time, incident id, dashboard version |
| `severity` | `critical` · `high` · `medium` · `low` |
| `incident_id` | the form's UUID |
| `reported_at` | ISO time the api received it |
| `chain` / `router_id` | a spec index and a config router id the values file declares, or null |
| `reporter` | `{name, email, phone, signed_in, role}` |
| `dashboard_version` | the api's `APP_VERSION` |

`title`, `message` and `reporter` are free text. The integration's templates
(in `smart-router-infrastructure`) put the tenant and `title` in every
notification's title, a call and an SMS included, and the whole `message` in
the Slack post — escaped and in a code block, so a reporter's text is never a
mention or a link there. The MAG ticket carries the whole report as text.

## Grouping and retries

IRM groups alerts by `alert_uid`; one that matches a group still open joins it
without a new escalation.

- **Critical: one key per clock hour (UTC)**, `critical-2026-10-18T14`. The first
  Critical in an hour calls the rota; any further Critical that hour joins that
  group. A form anyone can reach would otherwise ring the rota every time it is
  pressed. A new hour opens a new group, so a group nobody resolved swallows
  reports for an hour at most — and once the on-call resolves it, the next
  Critical calls again straight away.
- **Everything else: `report-<id>`**, the UUID the form mints when it opens. The
  draft (id included) survives closing the dialog and is replaced only after an
  accepted send, so a retry after a timeout joins the report that may already
  have landed instead of filing a second one.

## Limits

| Limit | Default | Why |
|---|---|---|
| Per caller | 3 per 10 min (`INCIDENT_RATE_LIMIT_MAX`) | Keyed on `cf-connecting-ip`, which Cloudflare sets in front of the fleet, then the connection. Not `request.ip`: behind the gateway that is an in-cluster hop shared by everyone on the node, so one caller could lock out the rest. Without Cloudflare a caller can choose the header — which only gets them a fresh allowance, as a new address would |
| Per api process | 10 per 5 min (`INCIDENT_POD_MAX`) | IRM caps alerts at 300 per 5 min per integration and **900 per 5 min per organisation**, and fleet alerts are delivered on that organisation budget. Callers change address for free, so only a total protects it. The chart runs one api per node, so a deployment's ceiling is this times its node count |

Past either limit the api answers 429 and the dialog says so.

## Configuration

| Container | Variable | |
|---|---|---|
| api | `INCIDENTS_ENABLED` | exactly `true` (any case) turns the route on |
| api | `INCIDENT_WEBHOOK_URL` | the IRM integration's URL. **The URL is the credential** — from a Secret, never a plain chart value (the chart writes its values into a ConfigMap). https only; http for a loopback mock |
| api | `INCIDENT_WEBHOOK_TIMEOUT_MS` · `INCIDENT_RATE_LIMIT_MAX` · `INCIDENT_POD_MAX` | see above |
| web | `INCIDENTS_ENABLED` | shows the button; set it with the api's |

On with no usable URL is not a refused boot — losing the customer's dashboard
over the report form would be the worse outage. The api logs the problem at
boot (never the URL) and answers every report with 503.

### Trying it locally

Any server that answers 2xx on a loopback address stands in for IRM. Run the
api and the web on the host, not in compose — inside a container `127.0.0.1`
is the container:

```bash
INCIDENTS_ENABLED=true \
INCIDENT_WEBHOOK_URL=http://127.0.0.1:9099/integrations/v1/formatted_webhook/test/ \
HELM_VALUES_DIR=<dir holding core/values.yml> NODE_ENV=development \
pnpm --filter @sr/api dev

INCIDENTS_ENABLED=true pnpm --filter @sr/web dev
```

## Code

| | |
|---|---|
| `apps/api/src/routes/incidents.ts` | the route, both auth modes, the limits |
| `apps/api/src/services/incidents.ts` | grouping key, cleaning, payload, delivery, the per-process budget |
| `apps/api/src/config.ts` → `readIncidentSettings` | the switch and the webhook, from the live env |
| `apps/web/src/components/incidents/ReportIncident.tsx` | the button and the dialog |
| `packages/shared/src/constants/incidents.ts` | severities, the words the reporter reads, field limits |
