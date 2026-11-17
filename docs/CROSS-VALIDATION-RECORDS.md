# Cross-validation records

MAG-2788. A router with smart-router #712 (MAG-2787) writes one record for
every cross-validated request, agreed or failed: what was asked, the policy as
resolved for that request, how each provider answered, and what was served.
It goes into the router's log, which the fleet ships to Loki. This api reads
those records back for a customer's own tooling:

```
GET /api/audit/cross-validation/records
```

Requires `AUTH_MODE=enabled` and `LOKI_URL`. Without accounts the route does
not exist. Without `LOKI_URL` it answers **503**.

## Who can read them

- **An audit token** ([`AUDIT.md`](./AUDIT.md#audit-tokens)). The route is under
  `/api/audit/`, so the token an admin mints for the audit pull reads the
  records too. Nothing about what a token can reach changed: it is still
  `GET`/`HEAD` under `/api/audit/`, token management excluded.
- **Any signed-in person, of any role.** Every role can read the audit log,
  so every role can read these too.
- **Only this deployment's records.** The api reads Loki with this
  deployment's credential. The fleet's Loki takes the org from that credential
  and ignores any org header a caller sends. A caller cannot name another
  customer, because nothing in the request says whose records to read.
- **An expired or revoked token gets a 401.** A token can be minted with an
  `expiresAt` (`POST /api/audit/tokens {"name": "…", "expiresAt": "<RFC 3339>"}`).
  Without one, it works until it is revoked.
  - **To rotate a token:** mint the new one, move the puller to it, then revoke
    the old one.

## Query

| Parameter          | Meaning |
| ------------------ | ------- |
| `from` / `to`      | RFC 3339 bounds on when the line was logged, both inclusive. Default: 90 days ago to now |
| `provider`         | Records that asked this provider, by the name the router's config gives it |
| `provider_outcome` | How that provider took part: `agreed`, `disagreed`, `node-error`, `protocol-error` or `not-received`. With `provider=X`, `disagreed` is every check X dissented on, a late dissent included. Without `provider`, any provider |
| `chain`            | The record's `chainId`, e.g. `ETH1` |
| `method`           | The record's `method`, e.g. `eth_getBlockByNumber`. **Not a REST path** (below) |
| `status`           | `success` or `failed` |
| `reason`           | The record's `failureReason`, e.g. `no-agreement`, `insufficient-capacity` |
| `request_id`       | One request: the `Lava-Guid` the caller got back |
| `order`            | `asc` (default: oldest first, resumable) or `desc` (newest first) |
| `per_page`         | At most this many records per page. Default 100, max 1000 |
| `after`            | The `cursor` from the previous response |

Filters combine with AND. Each one is decided on the parsed record. The line
filters sent to Loki only narrow what it returns.

The response is `{ items, cursor, has_more }`. Each item is:

```json
{
  "logged_at": "2026-11-17T10:00:00.123456789Z",
  "source": { "service": "kraken-eth", "pod": "smart-router-eth-7c9f-x2" },
  "record": { "time": "…", "seq": 812, "requestId": "…", "chainId": "ETH1", "status": "success", "endpoints": [ … ], … }
}
```

`record` is exactly what the router wrote: never reshaped and never
summarised. The router's README defines its fields. `seq` counts per router
process, so a gap in it marks a dropped record only within one `source.pod`.

## Paging

Store `cursor` and send it back as `after`. Some rules:

- **Pages run in log order, not in the order of `record.time`.** A record
  whose stragglers were still out is written when they resolve, after records
  of later requests.
- **A cursor resumes exactly.** It holds a line's nanosecond timestamp and
  the lines at that timestamp already served, so a resume never skips or
  repeats a record.
- **Oldest-first reads stop a minute short of now.** A line can reach Loki
  that long after it was written, and a cursor past it would skip it for good.
  The next pull picks it up.
- **A page can be short or empty while `has_more` is true.** Each Loki read
  is sized to the same log budget as the dashboard's other log lists. Loki
  answers at most 30 days per read, and a page makes at most three reads. The
  records share their streams with every other router line, so a busy stretch
  can be read without finding a single record.
- **A cursor carries its filters and order.** Resuming under different ones
  is a **400**, because answering would silently skip records. A malformed
  time, an unknown `provider_outcome`, or a cursor this endpoint did not issue
  is also a 400.
- **A failed read is a 503, never an empty 200.** "Loki did not answer" and
  "there were no records" are opposite answers. If Loki stops answering
  partway through a page, the page ends at the last read that succeeded.

```sh
TOKEN=srdash_audit_…
CURSOR_FILE=.cv-cursor
after=$(cat "$CURSOR_FILE" 2>/dev/null)
page=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "https://dash.example.com/api/audit/cross-validation/records?per_page=500${after:+&after=$after}") || exit 1
jq -c '.items[]' <<<"$page" >> cv-records.ndjson
jq -r '.cursor' <<<"$page" > "$CURSOR_FILE"
# has_more=true: run again now; false: everything settled so far is read.
```

## Known limits

- **REST methods can't be filtered on.** The fleet's log agent masks every
  absolute path before it is stored (credential redaction), so a REST
  record's `method` reaches Loki as `/REDACTED`. A `method` starting with `/`
  is refused with a 400 rather than answered with an empty page. Filter REST
  chains by `chain`.
- **The fleet's Loki keeps 45 days.** The 90-day default only reaches as far
  back as the store keeps. Keeping records longer, and reading them without
  scanning every router line, needs the log agent to put them in their own
  stream (as it already does for writes, `stateful="1"`) and a retention rule
  for that stream. That is infrastructure work.
- **Records from routers before smart-router #712** do not exist. Those
  routers wrote none.

## Wiring

| Piece   | Where |
| ------- | ----- |
| Route   | `apps/api/src/routes/cross-validation-records.ts` |
| Reading | `apps/api/src/services/cross-validation-records.ts` (filters, cursor, reads), `read-range.ts` (`readStop`) |
| Token   | `apps/api/src/plugins/auth.ts` (`auditTokenMayReach`), `packages/db/src/audit-tokens.ts` (expiry), `0010_audit_token_expiry.sql` |
