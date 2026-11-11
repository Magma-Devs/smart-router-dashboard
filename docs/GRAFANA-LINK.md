# Customer Grafana link

Set `DASHBOARD_GRAFANA_DASHBOARD_URL` on the web container to the customer's full
Grafana dashboard URL. It is read at request time, so the same frontend image
works for every tenant. The sidebar adds **Advanced → Grafana**, with a reports
icon, and opens the exact URL in a new tab. `/api/config` also returns it as
`grafanaDashboardUrl`.

Unset, empty, whitespace-only or invalid URLs hide both the link and its section.
Only absolute HTTP(S) URLs without embedded credentials are accepted. This setting
has no build-time fallback and does not change `DASHBOARD_GRAFANA_URL`, which is
the base URL for the existing **View full logs** button.

Docker Compose passes the variable to the web container:

```dotenv
DASHBOARD_GRAFANA_DASHBOARD_URL=https://example.grafana.net/d/customer/reports?from=now-5m&to=now
```

With smart-router Helm chart 6.19.0 and dashboard 0.34.2 or later, set
`dashboard.grafanaDashboardUrl`. In the
infrastructure repository's tenant wrapper this is nested under `smart-router`:

```yaml
smart-router:
  dashboard:
    grafanaDashboardUrl: 'https://example.grafana.net/d/customer/reports?from=now-5m&to=now'
```

Publish the chart and dashboard images containing this feature before updating a
tenant's version pins. The link only provides navigation; Grafana manages access.
