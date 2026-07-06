# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in smart-router-dashboard, please **do not** open a public GitHub issue. Email <security@magmadevs.com> instead with:

- A description of the issue and its potential impact.
- Steps to reproduce.
- Affected version(s) — the dashboard commit shown on the Account page or by `GET /version` on the api.
- Any suggested mitigation.

We aim to acknowledge reports within 2 business days. Confirmed vulnerabilities are resolved within 90 days, coordinated with affected customers, and disclosed publicly via a GitHub Security Advisory after patches ship and a reasonable update window (typically 7–14 days).

## Supported versions

Only the latest released minor version line receives security patches. Subscribe to the [Releases page](https://github.com/Magma-Devs/smart-router-dashboard/releases) for update notifications.

## Scope

In scope:

- The dashboard api and web apps under `v2/` and the published Docker images at `ghcr.io/magma-devs/smart-router-dashboard/{api,web}`.
- The authentication layer (Auth.js sign-in, JWT validation, the users database) when `AUTH_MODE=enabled`.
- The release pipeline configuration (`.github/workflows/`, `v2/apps/*/Dockerfile`).

Out of scope:

- Vulnerabilities in the Smart Router itself — report those to the [smart-router](https://github.com/Magma-Devs/smart-router) repo per its SECURITY.md.
- Vulnerabilities in upstream RPC providers or Prometheus.
- Configuration mistakes that expose the dashboard to the public internet with `AUTH_MODE=disabled`; the no-auth mode is intended for local/private deployments.
