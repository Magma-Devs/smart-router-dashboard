# Usage data

What clients open, search and click on the dashboard, so the layout is decided
from what they do (MAG-5373). The browser runs Mixpanel's browser SDK
(`mixpanel-browser`) with autocapture, session replay, heatmaps and a profile
per signed-in person, and sends the dashboard's own events beside them
(MAG-5402). Every report splits per client on the `tenant` property.

## What we optimise for

| Goal | Read it from |
|---|---|
| **Time to answer** - how fast someone gets what they came for | `view_ready.seconds`; a session's time from its first page view to the first `row_open` or `panel_open` |
| **Self-serve** - the answer without messaging Magma | sessions that end after an opened row, against sessions that end after a click on the Grafana or Report incident links |
| **A screen you can trust** | `view_problem` by `view`; `view_ready.failed` |
| **Low effort** | events per answer; `$mp_rage_click` and `$mp_dead_click`; `help_open` (the words weren't enough); session replays of the sessions that stalled |
| **Only what is used** | `$mp_click` and heatmaps per page, `panel_open` and `filter_use` per value per tenant: what is never used is a candidate to remove |

Leave our own team out of every report with `staff != true`: every event and
every profile says whether the signed-in person's address is at
`magmadevs.com`. A staff member's profile also carries their address; a
customer's never does.

Count clients, not people, with Mixpanel's group analytics on `tenant`: every
event carries it, so the group key is a project setting in Mixpanel (Project
Settings → Group Keys → `tenant`), with no code behind it.

## On or off

Three things have to be true, and the first two are the deployment's:

1. **Accounts are on** (`AUTH_MODE=enabled`). Usage data is recorded only for
   a signed-in user. With accounts off it is off, whatever else is set.
2. **The deployment has it on**, and holds `MIXPANEL_TOKEN` (deliver it from a
   Secret):

   | Deployment | Default | Switch |
   |---|---|---|
   | We host it (`DEPLOYMENT_MODE=managed`) | on | `USAGE_ANALYTICS=off` |
   | The client hosts it (`onprem`) | off | `USAGE_ANALYTICS=on` |

3. **The signed-in person accepted it.** Where the first two hold, the
   dashboard shows a consent banner, docked bottom-right: essential cookies
   keep the sign-in, and with **Accept** Mixpanel also records clicks, pages
   and session replays, with text hidden. **Decline** records nothing, and so
   does the X, which is kept as a "no". The banner links Magma's Privacy
   Policy (`magmadevs.com/privacy`) and Terms & Conditions
   (`magmadevs.com/terms`). The answer belongs to one account in one browser:
   it is kept in `localStorage` under `sr:usage-consent:2:<viewer.id>`
   (`accepted`, `rejected` or `dismissed`), so another account signed in on
   the same browser is asked for its own. The `2` is the banner's wording:
   an answer given to 0.70.0's banner (`sr:usage-consent`), which asked about
   events only, is not read, and the banner asks again. The answer holds in
   that account's other tabs of the dashboard at once, and the Account page
   shows it with a button that changes it.

A browser with Do Not Track on sends nothing, even after an acceptance: the
SDK honours it (`ignore_dnt` is left off), and the Account page says
"Analytics are off in this browser: it sends Do Not Track, so Mixpanel
records nothing here, whatever your answer."

`GET /api/usage/config` answers `{ enabled: false }` unless the first two hold
and a signed-in user is on the request. Then it answers what the browser
starts the SDK with: `{ enabled: true, token, apiHost, tenant, deploymentMode,
version, viewer: { id, staff, role, email?, created, twoFactor, signIn } }`.
`email` is there for staff only. `created` is the month the account was made
(`2026-11`), `twoFactor` whether an authenticator is set up, and `signIn` how
this session signed in (`password`, `google`, `github`, `invite` or `other`;
the first factor, never the code after it). `viewer.id` is the first 32 hex
characters of sha256(`<tenant>:<user id>`): the same person on every visit to
one deployment, and nothing that leads back to the account without its
database. The web asks for it on the first render of every signed-in page,
before it reads the banner's answer, so every signed-in browser holds the
project token while usage data is on; a Mixpanel project token is meant for
browsers. The api itself never talks to Mixpanel.

On Kubernetes the chart sets these (smart-router-helm-chart, `dashboard.usage`):
`enabled` renders `USAGE_ANALYTICS=on` and `existingSecret` hands
`MIXPANEL_TOKEN` to the backend from a Secret. One project token serves every
deployment: each event carries the tenant. A deployment without the Secret
starts with usage data off.

| Variable | Default | |
|---|---|---|
| `USAGE_ANALYTICS` | managed: on, onprem: off | `on` / `off` |
| `MIXPANEL_TOKEN` | unset | the project's token; handed to a signed-in browser only while usage data is on |
| `MIXPANEL_API_HOST` | `https://api-eu.mixpanel.com` | the one host the browser sends to; https only (http for a loopback mock) |
| `USAGE_TENANT` | `TENANT_ID` | the tenant on every event and profile |
| `USAGE_STAFF_DOMAINS` | `magmadevs.com` | a user whose address is at one of these (anyone `@magmadevs.com`) is `staff: true`, and their profile carries their address |

The api reads all five when it starts; the web reads none. Docker Compose
(`docker-compose.yml`, `docker-compose.dev.yml`) passes each one to the api
from the shell or `.env`.

## What the browser does

Before an acceptance nothing of Mixpanel's is imported, loaded, stored or
sent, and nothing of ours is kept but the answer. After one, the web loads the
SDK as its own chunk of the dashboard's code (`await import("mixpanel-browser")`;
the npm bundle carries the replay recorder, so no script comes from Mixpanel's
CDN), starts it, names the viewer by `viewer.id`, registers `tenant`,
`deployment_mode`, `dashboard_version`, `staff` and `role` on every event, sets
the viewer's profile (below), and opts in (once: a
browser already opted in is not opted in again, so `$opt_in` is sent once).

The SDK's storage in a browser belongs to one account: the web notes whose it
is (`sr:usage-sdk-viewer`), and when another account accepts there, removes
everything the SDK kept before it starts, so the two accounts share no device
id and Mixpanel never links them. **Signing out** (the sidebar's Sign out, the
enrolment screen's way out, "Sign out everywhere", or a session ended
elsewhere) stops the recording, resets the SDK (a new device id, nothing of
the account kept) and forgets whose its storage was. The account's answer
stays with the account.

The browser contacts one host, `MIXPANEL_API_HOST`: `/track/` for events,
`/engage/` for the profile and `/record/` for session replays. Mixpanel sees
the browser's address there and derives a city and country from it (`ip` is
left on). The SDK keeps its state in `localStorage` and `sessionStorage`
(keys starting `mp_` or `__mp`) and replays waiting to be uploaded in the
IndexedDB database `mixpanelBrowserDb`. It sets no cookie, so "essential
cookies keep you signed in" stays true.

### What is recorded

- **Autocapture:** a page view when the path changes, including a client-side
  navigation (`$mp_web_page_view`); clicks (`$mp_click`), dead clicks and rage
  clicks; that an input changed (`$mp_input_change`), never what it holds;
  scroll depth; form submits; leaving a page. A click names the element by
  its tag, classes, place among its siblings, role, type and name; never its
  text (`capture_text_content: false`), and the SDK never reads its `title`,
  `aria-label`, `aria-labelledby` or `aria-describedby` (`block_attrs`). The
  SDK copies no campaign tags or ad click ids out of the address
  (`track_marketing: false`, `store_google: false`,
  `skip_first_touch_marketing: true`).
- **Session replay:** every session (`record_sessions_percent: 100`), as the
  page's layout and changes, mouse movement, scrolls and clicks. All text is
  masked (`record_mask_all_text`), every input is masked
  (`record_mask_all_inputs`), images, video, audio and the 2FA QR are blocked
  (`record_block_selector: "img, video, audio, .gw-no-replay"`), and the
  console and network are not recorded (`record_console: false`;
  `record_network` is off). A replay stops after 30 minutes with nobody at
  the page. **The 2FA enrolment is never recorded:** while its screen is up
  (`/account/two-factor`, or the enrolment screen that takes over the
  dashboard), the recording is stopped and none starts; a new replay starts
  when it goes. Its QR tile is blocked as well.
- **Heatmaps:** from the clicks and the replay (`record_heatmap_data: true`).
- **Profiles:** one per signed-in person, by `viewer.id`: `$name`,
  `$created`, `tenant`, `staff`, `role`, `two_factor`, `sign_in`, `$email` for
  staff only, and Mixpanel's own operating system and browser. `$name` is a
  staff member's address, else `<tenant> · <role> · <first 8 of the id>`;
  `$created` is the first day of the account's month.
- **The dashboard's own events** (below): what autocapture can't see.

### What is redacted, and where

Every URL and clicked element an event or a profile update carries is
redacted before the SDK queues it (its `on_track` hook) and again before it
sends it (`before_send_events`, `before_send_people`), by
`apps/web/src/lib/usage-redact.ts`:

| What | Kept as |
|---|---|
| The dashboard's own address (`$current_url`, `$referrer`, `$initial_referrer`, `current_url_path`, `current_url_search`, `$pathname`, a link's `href`) | the path, each segment kept only when it is one of the routes' fixed segments (`/metrics`, `/account/two-factor` …), every other one `:id` (`/invite/:id`); the query keys the dashboard writes, a value kept only when it comes from a fixed set (`tab`, `window`, a known `chain` or `upstreamChain`, the audit `group` and `size`), every other value `:id` (`request=:id`, `upstream=:id`, `actor=:id`); any other key, and the fragment, dropped |
| Another site's address (an explorer, Grafana) | its origin only (`https://etherscan.io`) |
| Any other property holding an http(s) URL | the same |
| A clicked element and its ancestors (`$elements`), and the clicked element again (`$target`) | tag, classes, place among its siblings, role, type, name, an id of ours (`gw-…`) and its link target as above; titles, labels, other ids and text dropped |
| The clicked element's id (`$el_id`) | kept only when it is an id of ours (`gw-…`), else dropped |
| What the SDK reads from the address on its own: campaign tags (`utm_…`, `initial_utm_…`), ad click ids (`gclid`, `fbclid`, `msclkid` …) and a search engine's query (`mp_keyword`) | dropped |

Session replay uploads are scrubbed in the browser with the same rules
before they leave it, by `apps/web/src/lib/usage-replay.ts`. The SDK uploads
a replay with `fetch` to `<api host>/record/`; while usage data is on, `fetch`
is wrapped for that path alone. The upload's URL has every address in its
query redacted (`$current_url`, `replay_start_url`); its body is unzipped, and
each meta event's `href` is redacted, and every element's attributes, in full
snapshots, added nodes and attribute changes, keep a link or source target,
and any other attribute whose value is an http(s) URL, only as above, and
lose titles, labels, alt text, placeholders, values, `data-*` (but
`data-theme` and `data-density`, which the styles read and which hold a value
from a fixed set) and any `id` or `for` that isn't one of ours. Every other
attribute is kept: the player draws the page from them (an icon's `d` and
`viewBox`). What must never be in a replay is never recorded instead: the 2FA
enrolment and its QR (above). The body is zipped again and sent with the
SDK's own headers. An upload that can't be read, scrubbed or re-encoded is not
sent: the SDK is answered as if it had been, so it does not retry, and the
page counts it. The scrubber wraps `fetch` before the SDK starts, so a
recording a stored acceptance starts at once is scrubbed too.

### What is never sent

To events, profiles or replays: no customer's name, email or account id (a
staff member's profile carries their address, nothing else does); no Ask
question or answer text; no request ID,
transaction hash, customer or caller id, filter value, typed text or node url,
in a URL, an element's attributes or its text. Our own events keep only the
fields the catalog lists (`packages/shared/src/constants/usage-events.ts`),
each a closed list, a yes/no, a bounded number, a chain's spec, a window key,
or one of the api's listed reads (`USAGE_VIEWS`, with `:id` where the path
carries an id or what was typed into a look-up); anything else is dropped
before it is sent. A replay differs from an event in what it shows of the
page: its layout, classes and inline styles, and where the mouse moved and
clicked, with every piece of text as asterisks.

### A "no" after a "yes"

**Decline**, the X, or **Turn off** on the Account page, here or in another
tab of the dashboard, stops the recording, opts the SDK out and makes it
forget the viewer, removes every `mp_` / `__mp` key from `localStorage` and
`sessionStorage`, empties `mixpanelBrowserDb` (deleted on the next page load,
since the SDK holds it open until then) and takes the replay scrubber off
`fetch`. Nothing more is sent from that page. **Accept** or **Turn on** on the
same page starts it again; a browser whose answer is "no" never loads the SDK.

### Why these settings

- `consent_mode: "require_consent"`: the SDK stores and sends nothing until
  the opt-in, and keeps a withdrawal in memory after its stored flag is removed.
- Autocapture set up after the opt-in: under `require_consent` the first page
  view at start-up is not sent, so autocapture starts again once tracking is
  allowed.
- The `on_track` hook beside `before_send_events`: the SDK sends an event left
  queued by a closed tab without running `before_send_events`, so events are
  redacted before they are queued too.
- `record_console: false`: the console is not masked, and an api error's
  message can name an address.
- `save_referrer: false`: the first referrer is not kept in the SDK's storage
  or set on the profile; each event's `$referrer` is redacted.
- `block_attrs` (`title`, `aria-label`, `aria-labelledby`,
  `aria-describedby`): in this UI they carry hashes, request IDs, customer ids
  and the signed-in person's address; the redaction drops them too.
- `track_marketing: false`, `store_google: false`,
  `skip_first_touch_marketing: true`: campaign tags and click ids are values
  from the address that the query rules would not keep; the redaction drops
  the ones the SDK adds to a page view regardless.
- The QR's class in `record_block_selector`, and the recording stopped while
  the enrolment is up: the QR is the account's second factor, and the
  replay keeps the attributes an SVG is drawn from.

## Events

Every event carries `distinct_id` (`viewer.id`), `tenant`, `deployment_mode`,
`dashboard_version`, `staff` (yes/no: the signed-in user's address is at
`magmadevs.com`) and `role` - never the address. `page` is one of `metrics`,
`upstreams`, `team`, `audit`, `account`, `standalone`, `ask` and `other`.
Autocapture's events are
above; these are the dashboard's own:

| Event | Fields | Sent when |
|---|---|---|
| `view_ready` | `page`, `tab`, `seconds`, `reads`, `failed` | a page or tab has all its data: from opening it (the first page of a load: from when the browser started loading) until its reads settled, once per view; 0 reads = from the cache |
| `help_open` | `page`, `tab` | a "More about this" note held open past a glance (0.8 s) |
| `idle_paused` | `page`, `tab` | polling paused after an hour with nobody at the page |
| `tab_change` | `from`, `to` | the Metrics tab changes, whatever changed it (the tab bar, a bar or line, Back) |
| `chain_pick` | `chain`, `from` (list / router-row / cleared) | a chain is picked in the chains list or a router row |
| `router_pick` | `from` | a router is picked under its chain |
| `time_range_change` | `from`, `to` | the time range is changed |
| `row_open` | `list` (errors / transactions), `result` | a request row is opened |
| `panel_open` | `panel` (router-row / chart-tile / provider / see-requests / errors-bar / timeline-line / grouped-error) | a panel is opened |
| `filter_use` | `list`, `filter` (view / result / retryable / error-type / customer / method / provider / time) | a list filter is changed |
| `load_older` | `list` | "Load older" is clicked |
| `view_problem` | `view`, `problem` (did-not-load / slow), `seconds` | a read fails (network or server error - a 4xx is the request's, not the screen's) or takes over 10 s, once per view a page load; reads cut short by leaving the page are not counted |
| `ask_question` | `view` (always full: Ask is one page), `page` (overview / dashboard / metrics / upstreams / ask), `new_chat`, `chain` (yes/no: a chain was picked) | a question is accepted by the api; never the question |
| `ask_answer` | `result` (succeeded / failed / cancelled / interrupted), `error` (the run's `ASK_…` code, or other), `seconds`, `sections`, `evidence` | a question this tab sent ends, read from `GET /api/ask/runs/:id` while usage data is recorded; `seconds` from sending to the end; never the answer. A tab closed before the end sends none |

## Reading it

- **Does a session stay in one tab?** The order of `tab_change` events in a
  session (Mixpanel Flows on `distinct_id`).
- **Where people get stuck:** `view_problem` by `view`, rage and dead clicks
  by page, and the replays of sessions that stalled.
- **What is never used:** clicks and heatmaps per page, `panel_open` and
  `filter_use` counts per value, per tenant.
- **Does Ask answer?** `ask_answer.result` and `error` per tenant, and
  `seconds` against `ask_question`; a view of the Ask page without an
  `ask_question` in the session is someone who opened it and asked nothing.
- **New people or old hands?** Any report broken down by the profile's
  `$created`, `two_factor` or `sign_in`.

## Who a usage id is

Mixpanel names a customer by `viewer.id` only. An admin of the deployment
turns one back into a member at `/team?usage=<id>`: the Team page says which
member it belongs to (removed members included) or that none does. Behind it
is `GET /api/usage/viewers/:id`, admins only, which hashes every account of
the deployment and answers `{ member: { id, email, name, role, status } }` or
`{ member: null }`. It names no one an admin can't already see on the Team
page, and works whether usage data is on or off. The `?usage=` value is never
sent to Mixpanel: the redaction drops a query key the dashboard does not
write.
