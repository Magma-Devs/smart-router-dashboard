# MAG-4934 runtime preparation evidence

16 November 2026. This slice follows dashboard [PR #396](https://github.com/Magma-Devs/smart-router-dashboard/pull/396)
(UI; Quality Gate and both Browser jobs passed on `4ad43cb3`).

## Observed locally

- Workspace: **3,711 tests passed**, **24** additional actual HTTP/PostgreSQL
  checks passed, typecheck and API production build passed. Lint: zero errors,
  14 existing warnings. Browser/web behavior is unchanged from PR #396.
- Nine operator-preflight checks prove explicit managed/authenticated opt-in,
  current price validation before network work, rejected identity/empty catalog
  stopping before Bedrock, free tool-input counting and no paid inference or
  fallback on denial. Output excludes source names, credentials and exceptions.
- A configuration regression check proves invalid retention still blocks
  execution while keeping cleanup bounded to 90 days; a shorter valid policy
  remains intact. The real PostgreSQL retention/accounting checks still pass.
- `docker compose config --format json` succeeds for production/development
  Compose with availability both off and on (four combinations, synthetic input).
  Both runtimes receive the flag; credentials/prices stay on the API; no provider
  value is a frontend build argument. Default cap is $10 and retention 90 days.
- The operator runbook maps deployment ownership, current readiness, normal
  metered smoke, staff/retention evidence and consistent enable/disable/rollback.

## Still unverified

The current live MCP catalog and an actual customer-only read, supported free
counter, priced Bedrock inference/usage receipts, live authorized staff OAuth
records/export, runtime cleanup/backups/provider logging policies, fleet Secret
and released pin delivery, and controlled GK8 enable/disable/rollback are pending.
The latest provider evidence remains Bedrock HTTP 403; `magma` SSO expired and the
alternate maintenance profile denied the exact GK8 MCP parameter. No broader
credential, IAM grant, cloud resource, customer pin or feature flag was substituted
or changed. The user has renewal instructions; successful renewed access has not
been observed.

No pilot-start date or 60-day outcome is claimed. The [acceptance ledger](../../ASK-YOUR-DATA-IMPLEMENTATION.md)
and [runbook](../../ASK-YOUR-DATA-OPERATIONS.md) retain those checkpoints explicitly.
