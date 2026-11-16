# Ask your data: foundation

[MAG-4750](https://magmadevs.atlassian.net/browse/MAG-4750) owns the canonical
scope. The [implementation and acceptance ledger](ASK-YOUR-DATA-IMPLEMENTATION.md)
tracks all six delivery slices. This document describes MAG-4929's foundation.

## Runtime configuration

The existing API holds both provider connections. The browser receives neither
AWS/MCP credentials nor configuration that selects the customer or destination.
Set these on the **backend process** or its Kubernetes Secret-backed environment;
a GitHub repository secret alone does not inject a running container's secret.

| Backend variable | Meaning |
| --- | --- |
| AUTH_MODE=enabled | Existing live PostgreSQL session gate |
| DEPLOYMENT_MODE=managed | Managed deployments only |
| ASK_DATA_ENABLED=true | Explicit per-deployment/customer availability |
| ASK_DATA_CUSTOMER_ID | Exact registry customer ID; separate from display name |
| ASK_DATA_MCP_TOKEN | Customer-only bearer credential; staff credentials are rejected |
| ASK_DATA_MCP_URL | Fixed trusted HTTPS endpoint, default staging /mcp |
| ASK_DATA_BEDROCK_REGION | Region, default us-east-1 |
| ASK_DATA_BEDROCK_MODEL | Explicit currently verified model/inference profile ID |
| AWS_BEARER_TOKEN_BEDROCK | Runtime bearer secret, independent of SES credentials |

Model/region/credential availability must be verified now. MAG-3702's historical
provisioning is not a current availability check. There is no provider/key fallback.
Use `secretKeyRef` for both tokens, never a public ConfigMap or frontend env. The
foundation does not change fleet resources or enable a customer deployment.

`GET /api/ask/capabilities` requires a live session and the deployment gates. It
returns contract version 1 and `acceptingQuestions:false`. There is no public
question endpoint yet. Disabled/auth-off/self-hosted deployments cannot invoke
either provider through it. Existing session revocation and 2FA gates apply.

## Identity and tool boundary

Every MCP connection uses the official SDK's Streamable HTTP transport. HTTP
requests have exact destination checks, no redirects/reconnection retries, a
20-second request deadline and 1 MiB response ceiling, including streamed bodies.
The adapter handles JSON and SSE responses. It never starts interactive OAuth.

`whoami` must prove exactly the configured customer and read scope. Reject staff
identities and broader tenant lists even if they include the customer. Discovery
validates source ownership and intersects each source's remote catalog with a
local audited GET-only operation policy. `execute_operation` cannot escape that
policy; strict local parameter validation rejects tenant/header/URL overrides.
The result envelope must match the same customer, source and operation. Workers
remain responsible for independently checking the current customer grant.

The catalog is capability-dependent: remote `main` implements `chain_events`,
while newer local MCP work and dated deployment reports have a different catalog.
No provider-status availability is claimed until a live discovery/read proves it.
The orchestration slice owns status policy support and unavailable-data answers.

## Answer and execution contracts

`@sr/shared` owns validated question/context/preferences/history and answer shapes,
stable run states/error codes and response types. Model content is bounded to a
summary and 1-8 sections, with optional points/stat. Server-authored evidence adds
the actual source, operation, observation/query times, coverage and truncation.
No model HTML is rendered. The server validates before persistence/display.

Bedrock uses [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html),
with a fixed server-selected region/model and explicit maxTokens. No temperature
is sent. Context is capped at 64,000 UTF-8 bytes; output at 2048 tokens. The adapter
does not retry potentially billable invocations. Its required usage callback runs
before output validation, including malformed/truncated answers. Missing usage
and transport failures are explicitly uncertain; later budget admission must keep
their reservation until reconciliation. Usage fields are retained for versioned
pricing rather than discarding cache/reasoning billing categories.

## Controlled operator checkpoint

With all runtime configuration already injected securely into the API process:

```sh
ASK_DATA_SMOKE=true pnpm --filter @sr/api ask:smoke
```

This reads one authorized metric (`count(up)`) and makes one bounded model call,
then validates the structured answer with server evidence. It is an operator
development check, not a customer spending route. Never put tokens directly in
shell history or commit an environment file. The command prints metadata and
usage only; no raw customer values, answer text or credential is printed.

Tests use mocked upstreams through the real MCP SDK transport plus the real
session gate over PGlite. These prove local boundary/error behavior. Real HTTP
with independent PostgreSQL connections, live providers, browser flows and the
GK8 rollout remain explicit later acceptance items.
