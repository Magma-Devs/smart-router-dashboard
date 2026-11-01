# Customer Grafana links

Each link is configured independently on the web container and read at request
time, so the same frontend image serves every tenant:

| Runtime environment | `/api/config` field | Advanced sidebar label |
|---|---|---|
| `DASHBOARD_GRAFANA_DASHBOARD_URL` | `grafanaDashboardUrl` | Logs & Metrics |
| `DASHBOARD_GRAFANA_CUSTOMER_USAGE_DASHBOARD_URL` | `grafanaCustomerUsageDashboardUrl` | Customer Usage |

Each uses a reports icon and opens the exact URL in a new tab with
`noopener noreferrer`, preserving Grafana variables, time range and refresh.
The server layout passes both to the shell independently of the API's health.
Unset, empty, whitespace-only or invalid URLs hide that link. **Advanced** is
hidden when neither link is valid. Only absolute HTTP(S) URLs without embedded
credentials are accepted. Neither setting has a build-time fallback or inherits
another deployment's URL. Both are independent of `DASHBOARD_GRAFANA_URL`, the
base URL for **View full logs**.

Docker Compose passes both variables to the web container:

```dotenv
DASHBOARD_GRAFANA_DASHBOARD_URL=https://example.grafana.net/d/customer/reports?from=now-5m&to=now
DASHBOARD_GRAFANA_CUSTOMER_USAGE_DASHBOARD_URL=https://example.grafana.net/d/customer/usage?from=now-24h&to=now
```

With smart-router Helm chart 6.24.0 and dashboard 0.52.0, configure the matching
values. The infrastructure repository's tenant wrapper nests them under
`smart-router`:

```yaml
smart-router:
  dashboard:
    grafanaDashboardUrl: 'https://example.grafana.net/d/customer/reports?from=now-5m&to=now'
    grafanaCustomerUsageDashboardUrl: 'https://example.grafana.net/d/customer/usage?from=now-24h&to=now'
```

Publish the chart and dashboard images before updating a tenant's version pins.
Use the infrastructure repository's `make update-versions` and `make set-value`
targets to activate the links. A link provides navigation; Grafana enforces
permissions through the customer's restricted folder and credential-scoped
data sources. Do not point a customer link at the staff fleet dashboard.
