# Usage data

What clients open, search and click on the dashboard, so the layout is decided
from what they do (MAG-5373). Each event goes from the browser to the api
(`POST /api/usage`) and from the api to Mixpanel's EU project, tagged with the
tenant. Mixpanel splits every report per tenant on the `tenant` property.

## On or off

| Deployment | Default | Switch |
|---|---|---|
| We host it (`DEPLOYMENT_MODE=managed`) | on | `USAGE_ANALYTICS=off` |
| The client hosts it (`onprem`) | off | `USAGE_ANALYTICS=on` |

Nothing is sent without `MIXPANEL_TOKEN` (deliver it from a Secret). Where it
is on, the Account page says so in one line. `GET /api/usage/config` answers
`{ enabled }`, and the web sends nothing while it is false.

| Variable | Default | |
|---|---|---|
| `USAGE_ANALYTICS` | managed: on, onprem: off | `on` / `off` |
| `MIXPANEL_TOKEN` | unset | the project's token; server side only |
| `MIXPANEL_API_HOST` | `https://api-eu.mixpanel.com` | https only (http for a loopback mock) |
| `USAGE_TENANT` | `TENANT_ID` | the tenant on every event |

## What is never sent

No name, email, account id or IP (`ip=0`, and the browser never talks to
Mixpanel). No request ID, transaction hash, customer or caller id, filter
value, typed text or node url. The api keeps only the fields the catalog lists
(`packages/shared/src/constants/usage-events.ts`), each a closed list, a
yes/no, a bounded number, a chain's spec, a window key, or an api path with its
ids replaced by `:id`; anything else is dropped before it is forwarded.

## Events

Every event carries `distinct_id` (a random id per browser tab, new after 30
minutes with no event), `tenant`, `deployment_mode`, `dashboard_version` and
its time.

| Event | Fields | Sent when |
|---|---|---|
| `visit_start` | `arrived` (link-request / link / typed), `page`, `tab`, `window`, `chain_picked` | the first event of a visit |
| `page_view` | `page`, `tab` | a page opens |
| `tab_change` | `from`, `to` | a Metrics tab is picked |
| `chain_pick` | `chain`, `from` (list / router-row / cleared) | a chain is picked in the chains list or a router row |
| `router_pick` | `from` | a router is picked under its chain |
| `time_range_change` | `from`, `to` | the time range is changed |
| `search` | `kind` (request-id / old-request-id / hash / other), `from` (top-bar / request-tab / link), `result` (found / not-found / stopped-early / error / unavailable), `seconds`, `older` | a look-up answers |
| `row_open` | `list` (errors / transactions), `result` | a request row is opened |
| `panel_open` | `panel` (router-row / chart-tile / provider / see-requests / errors-bar / timeline-line / grouped-error) | a panel is opened |
| `filter_use` | `list`, `filter` (view / result / retryable / error-type / customer / method / provider / time) | a list filter is changed |
| `load_older` | `list` | "Load older" is clicked |
| `link_out` | `target` (grafana / explorer / try-it / report-incident / copy) | a link out of the dashboard or a copy |
| `view_problem` | `view`, `problem` (did-not-load / slow), `seconds` | a read fails or takes over 10 s, once per view a visit; reads cut short by leaving the page are not counted |
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
