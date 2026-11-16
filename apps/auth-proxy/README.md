# auth-proxy — one sign-in callback for every dashboard

A Cloudflare Worker running [Auth.js](https://authjs.dev) as a **redirect
proxy** at `https://auth.magmadevs.com/api/auth`.

Google lists each redirect URI in full and takes no wildcard, so a dashboard
that is its own callback is a console edit at Google per hostname. With
`AUTH_REDIRECT_PROXY_URL` set, a dashboard names this Worker's callback to the
provider instead and carries its own callback inside the signed `state`; the
Worker validates the `state` with the shared `AUTH_SECRET` and sends the
browser on to the dashboard, which finishes the sign-in as before. The provider
knows one callback, registered once.

What runs here is `@auth/core` at the version `next-auth` pins for the web, so
the `state` the dashboards sign is the `state` this decodes. On top of Auth.js's
own behaviour, `src/proxy.ts` allows only `https://<CALLBACK_HOST_PATTERN>/api/auth/callback/<the same provider>`
as a destination: anything else, Auth.js's own error redirects included, is a
400 with no `Location`. The Worker never exchanges a code and holds no client
secret.

```
wrangler.jsonc   the build recipe (name, entry, compatibility date) — no route, no account, no credential
src/index.ts     the fetch handler
src/proxy.ts     the Auth.js config and the allowlist
src/__tests__/   a dashboard's Auth.js starting a sign-in, this proxy finishing Google's callback
```

What the Worker reads from its environment, all set by the deployment, none by
this repo:

| Name | Kind | What |
|---|---|---|
| `AUTH_REDIRECT_PROXY_URL` | var | its own base URL, `https://<host>/api/auth` |
| `CALLBACK_HOST_PATTERN` | var | the hostnames it may forward to, a regular expression |
| `AUTH_SECRET` | secret | the fleet's, shared with every dashboard behind the proxy |
| `GOOGLE_CLIENT_ID` | secret | the fleet's Google client (the id alone) |
| `GITHUB_CLIENT_ID` | secret | the fleet's GitHub app (the id alone), when GitHub rides the proxy too |

**Built here, deployed by the fleet.** Each release attaches the bundle,
`auth-proxy-<VERSION>.js` with its sha256, to the `v<VERSION>` GitHub release
(`build-and-push.yml`, the `publish-auth-proxy` job: `wrangler deploy
--dry-run --outdir dist`). devops-magmadevs pins the pair in its tfvars and
deploys it through the Workers API (`make deploy-auth-proxy`), and owns the
hostname, the route and the secrets (`make set-auth-proxy-secret`). See
[`docs/AUTH.md`](../../docs/AUTH.md#one-callback-for-every-dashboard-the-redirect-proxy).
