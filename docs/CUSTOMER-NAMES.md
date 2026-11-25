# Customer names

Every router counts each client request under the `customer-id` header its
caller sends (`smartrouter_customer_requests_total`, label `customer`). The
value is whatever the caller chose, often an opaque id such as a 64-character
hex digest. A deployment's admins give an id a name on the **Customers** page.
The dashboard and Ask then show the name wherever that id appears.

Names need accounts (`AUTH_MODE=enabled`): they live in the accounts database.
Without accounts there are no names. The Customers page is not in the menu,
its routes are not registered, and every list shows the ids as before.

## Where a name shows

| Surface | What it shows |
|---|---|
| Customers page (`/customers`) | Every id the routers counted in the last 24 hours, busiest first, and every named id. Each row has its name, its requests in the last 24 hours and when it was named. An admin names, renames and clears. |
| Transactions and Errors lists | The row's time cell and the Customer filter show the name. The id is in the tooltip. An opened request shows the name beside the id. |
| Ask | A `measure=customers` row, and each method row, carries `name` beside `customer`. Any other read whose result holds a named id as a whole value carries `customerNames` (id → name, at most 50). The prompt tells the model to call such a customer by its name. `customer` takes an id or a name. |

A name never leaves the deployment: it is not written to the metrics store,
the logs or the usage data. Ask sends it to the model as part of a tool result.

## Rules

- **The id** is a value the router counts under its own name: 1 to 128 bytes
  of UTF-8, with no control or format characters. `DefaultDappID` (no header),
  `other` (past the router's per-chain cap) and `magma-serving-probe` (Magma's
  serving probe) are the router's own values and take no name.
- **The name** is one line of 1 to 64 characters. It is stored in NFC, trimmed,
  with each run of spaces as one. It may not hold `` | ` < > \ [ ] `` or a
  control or invisible character, since these break a Markdown table or a link
  in an answer. It may not be a reserved value, in any case.
- **One name, one id.** Two ids never share a name, in any case. An index on
  `lower(name)` enforces it, and a second admin's clash answers `409`.
- **A name is never an id.** A name equal to another counted or named id, in
  any case, answers `409`. Ask reads a value as a named id before it reads it
  as a name, so such a name could never be reached.

## Ask's order for `customer`

`router_request_summary` with `measure=customers` takes `customer` as typed by
the model and resolves it in this order (`resolveSummaryCustomer`):

1. a named id, exactly as stored → that id;
2. a name, in any case and spacing → its id;
3. a value that can be an id (letters, digits and `._:@+=/-`, up to 128) → itself;
4. anything else → a tool error naming up to 20 known names, and no read.

Only a resolved id reaches a query. The query builder refuses any other value.

The worker reads the names once per run, with the conversation's history. A
read that fails leaves every id unnamed for that run and is reported as
`ASK_CUSTOMER_NAMES_UNAVAILABLE`. It never fails the answer.

## API

| Route | Role | Answers |
|---|---|---|
| `GET /api/customers` | any member | `CustomersResponse`: `window: "24h"`, `customers` (id, name, requests, changedAt; at most 1,000, busiest first), `requestsUnavailable` when the metrics store did not answer (then only named ids, without counts) |
| `GET /api/customers/names` | any member | `{ names: { <id>: <name> } }` |
| `POST /api/customers/name` | admin | body `{ customer, name }`; `name: null` clears. `400` for an id or name the rules refuse, `409` for a clash, `503` until the database is ready |

The id travels in the body: it may hold `/`, which a path does not carry
through every proxy. The requests come from
`round(sum by (customer) (increase(smartrouter_customer_requests_total{customer!~"DefaultDappID|other|magma-serving-probe"}[24h])))`,
the counter and window Ask's customers summary reads.

## Storage and audit

`customer_names` (migration `0016_customer_names`): `customer` (primary key),
`name`, `changed_by`, `changed_at`. Each change writes one audit row in the
same transaction, in the `config` group:

| Event | Change |
|---|---|
| `customer.named` | `name`: the old name, or `(none)`, → the new one |
| `customer.name_cleared` | `name`: the old name → `(none)` |

The row's target is `customer` with the id and the name. Saving the same name
again, or clearing an id with no name, changes nothing and writes no row.
