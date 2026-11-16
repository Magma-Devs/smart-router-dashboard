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
wrangler.jsonc   the Worker: name, custom domain, the public vars
src/index.ts     the fetch handler
src/proxy.ts     the Auth.js config and the allowlist
src/__tests__/   a dashboard's Auth.js starting a sign-in, this proxy finishing Google's callback
```

Secrets, set once with `wrangler secret put`, kept across deploys:

| Secret | What |
|---|---|
| `AUTH_SECRET` | the fleet's, shared with every dashboard behind the proxy |
| `GOOGLE_CLIENT_ID` | the fleet's Google client (the id alone) |
| `GITHUB_CLIENT_ID` | the fleet's GitHub app (the id alone), when GitHub rides the proxy too |

Deploy: `.github/workflows/auth-proxy-deploy.yml` on a push to `main` that
touches this app, or `pnpm --filter @sr/auth-proxy run deploy` with
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set. See
[`docs/AUTH.md`](../../docs/AUTH.md#one-callback-for-every-dashboard-the-redirect-proxy).
