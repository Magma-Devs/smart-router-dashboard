# Usage data

What clients open, search and click on the dashboard, so the layout is decided
from what they do (MAG-5373).

## What we optimise for

| Goal | Read it from |
|---|---|
| **Time to answer** - how fast someone gets what they came for | `view_ready.seconds`; `search.seconds` and `result`; time from `visit_start` to the first `row_open`, `search: found` or `panel_open` |
| **Self-serve** - the answer without messaging Magma | visits that end after a found search or an opened row, against visits that end after `not-found`, a `link_out: grafana` or `report-incident` |
| **A screen you can trust** | `view_problem` by `view`; `view_ready.failed` |
| **Low effort** | events per answer; `rage_click`; `help_open` (the words weren't enough) |
| **Only what is used** | `panel_open`, `filter_use`, `link_out` per value per tenant: what is never used is a candidate to remove |

Leave our own team out of every report with `staff != true`: every event
says whether the signed-in user's address is at `magmadevs.com`. Each event
goes from the browser to the api
(`POST /api/usage`) and from the api to Mixpanel's EU project, tagged with the
tenant. Mixpanel splits every report per tenant on the `tenant` property.

## On or off

Three things have to be true, and the first two are the deployment's:

1. **Accounts are on** (`AUTH_MODE=enabled`). Usage data is sent only for a
   signed-in user. With accounts off nothing is sent, whatever else is set.
2. **The deployment has it on**, and holds `MIXPANEL_TOKEN` (deliver it from a
   Secret):

   | Deployment | Default | Switch |
   |---|---|---|
   | We host it (`DEPLOYMENT_MODE=managed`) | on | `USAGE_ANALYTICS=off` |
   | The client hosts it (`onprem`) | off | `USAGE_ANALYTICS=on` |

3. **The person at the browser accepted it.** Where the first two hold, the
   dashboard shows a consent banner, docked bottom-right: essential cookies
   keep the sign-in, and with **Accept** the dashboard also sends usage data
   to Magma through Mixpanel, a third party. **Decline** sends nothing, and so
   does the X, which is kept as a "no".
   The banner links Magma's Privacy Policy (`magmadevs.com/privacy`) and Terms
   & Conditions (`magmadevs.com/terms`). The answer is kept in that browser
   (`localStorage`, `sr:usage-consent`: `accepted`, `rejected` or
   `dismissed`), holds in its other tabs of the dashboard at once, and the
   Account page shows it with a button that changes it.

Before an acceptance the browser records nothing, sends nothing and keeps
nothing; an acceptance starts a visit from that moment. A rejection after an
acceptance drops what waited to be sent and removes the visit kept in the
browser. `GET /api/usage/config` answers `{ enabled }` for the first two.

On Kubernetes the chart sets these (smart-router-helm-chart, `dashboard.usage`):
`enabled` renders `USAGE_ANALYTICS=on` and `existingSecret` hands
`MIXPANEL_TOKEN` to the backend from a Secret. One project token serves every
deployment: each event carries the tenant. A deployment without the Secret
starts and sends nothing.

| Variable | Default | |
|---|---|---|
| `USAGE_ANALYTICS` | managed: on, onprem: off | `on` / `off` |
| `MIXPANEL_TOKEN` | unset | the project's token; server side only |
| `MIXPANEL_API_HOST` | `https://api-eu.mixpanel.com` | https only (http for a loopback mock) |
| `USAGE_TENANT` | `TENANT_ID` | the tenant on every event |
| `USAGE_STAFF_DOMAINS` | `magmadevs.com` | a user whose address is at one of these (anyone `@magmadevs.com`) is `staff: true` |

## What is never sent

No name, email, account id or IP (`ip=0`, and the browser never talks to
Mixpanel). No request ID, transaction hash, customer or caller id, filter
value, typed text or node url. The api keeps only the fields the catalog lists
(`packages/shared/src/constants/usage-events.ts`), each a closed list, a
yes/no, a bounded number, a chain's spec, a window key, or one of the api's
listed reads (`USAGE_VIEWS`, with `:id` where the path carries an id or what
was typed into a look-up); anything else is dropped before it is forwarded.

## Events

Every event carries `distinct_id` (a random id per browser tab, new after 30
minutes with no event), `tenant`, `deployment_mode`, `dashboard_version` and
its time, and `staff` (yes/no: the signed-in user's address is at
`magmadevs.com`) and `role` - never the address.

| Event | Fields | Sent when |
|---|---|---|
| `visit_start` | `arrived` (link-request / link / typed), `page`, `tab`, `window`, `chain_picked`, `screen` (phone / tablet / laptop / wide), `theme` | the first event of a visit |
| `view_ready` | `page`, `tab`, `seconds`, `reads`, `failed` | a page or tab has all its data: from opening it (the first page of a load: from when the browser started loading) until its reads settled, once per view; 0 reads = from the cache |
| `help_open` | `page`, `tab` | a "More about this" note held open past a glance (0.8 s) |
| `rage_click` | `page`, `tab` | three clicks within 0.8 s in one spot, once per 2 s |
| `idle_paused` | `page`, `tab` | polling paused after an hour with nobody at the page |
| `page_view` | `page`, `tab` | a page opens |
| `tab_change` | `from`, `to` | the Metrics tab changes, whatever changed it (the tab bar, a bar or line, the top bar's search, Back) |
| `chain_pick` | `chain`, `from` (list / router-row / cleared) | a chain is picked in the chains list or a router row |
| `router_pick` | `from` | a router is picked under its chain |
| `time_range_change` | `from`, `to` | the time range is changed |
| `search` | `kind` (request-id / old-request-id / hash / other), `from` (top-bar / request-tab / link), `result` (found / not-found / stopped-early / error / unavailable), `seconds`, `older` | a look-up answers |
| `row_open` | `list` (errors / transactions), `result` | a request row is opened |
| `panel_open` | `panel` (router-row / chart-tile / provider / see-requests / errors-bar / timeline-line / grouped-error) | a panel is opened |
| `filter_use` | `list`, `filter` (view / result / retryable / error-type / customer / method / provider / time) | a list filter is changed |
| `load_older` | `list` | "Load older" is clicked |
| `link_out` | `target` (grafana / explorer / try-it / report-incident / copy) | a link out of the dashboard or a copy |
| `view_problem` | `view`, `problem` (did-not-load / slow), `seconds` | a read fails (network or server error - a 4xx is the request's, not the screen's) or takes over 10 s, once per view a visit; reads cut short by leaving the page are not counted |
| `visit_end` | `seconds`, `active_seconds`, `pages`, `tabs`, `events` | the tab is left; sent each time, the visit's last one holds its totals |

## Reading it

- **Does a visit stay in one tab?** `visit_end.tabs` per visit, and the order
  of `tab_change` events (Mixpanel Flows on `distinct_id`).
- **Chain first or ID first?** The first of `chain_pick` and `search` in a
  visit; `visit_start.arrived = link-request` for shared request links.
- **Where people get stuck:** `search.result`, `view_problem` by `view`, and
  visits whose last event before `visit_end` is a `not-found` search.
- **What is never used:** `panel_open`, `filter_use`, `link_out` counts per
  value, per tenant.
