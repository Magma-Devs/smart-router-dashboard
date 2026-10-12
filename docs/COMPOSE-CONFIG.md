# Compose configuration access

The Upstreams page reads the router configuration. Kubernetes is not required:
the API accepts both native Smart Router YAML and Helm values. Prometheus supplies
live measurements, not the complete configured topology.

## New self-contained installation

Put the native router YAML in a dedicated configuration directory, then run:

```bash
SR_CONFIG_HOST=/srv/smart-router/config/router.yml make up-config-router
```

With the bundled public configuration:

```bash
make up-config-router
```

The command builds the dashboard, checks the YAML as the API's non-root user,
and starts router, Prometheus, API and web. Both router and API mount the same
directory read-only; neither receives a copied configuration. Directory mounts
also see editors/deployment tools atomically replacing the YAML file.

The API runs as `node`. If a root-owned `0600` file cannot be read, installation
prepares group read access: it assigns the selected file and directory to the
numeric `SR_CONFIG_GID` (default `2000`), makes the file `0640`, and enables group
read/traversal of that directory. File ownership and contents are unchanged.
Only the short-lived preparation container runs as root. Use a **dedicated
configuration directory**, since its group also changes. Select a group ID
appropriate to your host if `2000` is already in use. Newly replaced files must
retain that group and read permission; `make apply-config` rechecks them and
prepares read access if needed before recreating the router.

Run the checks or explicitly prepare access without starting the stack:

```bash
SR_CONFIG_HOST=/srv/smart-router/config/router.yml make check-config
SR_CONFIG_HOST=/srv/smart-router/config/router.yml make prepare-config
```

An invalid or unsupported YAML file stops setup before starting/restarting
services. Diagnostic output contains only availability, format and router count;
parser exception text and source YAML are never printed.

## Dashboard alongside an existing router

```bash
SR_CONFIG_HOST=/srv/smart-router/config/router.yml make up-config
```

This starts only dashboard and Prometheus services. Mount the **same directory**
in your existing router container and configure it to use that YAML. The bundled
Prometheus config scrapes `host.docker.internal:7779`; adjust its target if your
existing router exposes metrics elsewhere. The dashboard cannot discover a file
that has not been connected to its container.

## Change upstreams

Edit the shared YAML and, when this Compose project manages the router, run:

```bash
SR_CONFIG_HOST=/srv/smart-router/config/router.yml make apply-config
```

It validates access/format and recreates **only the router** so it reads the new
configuration. Recreating rather than merely restarting also applies a changed
mount or filename. A valid YAML file still needs to satisfy the router's own
configuration rules; check its startup logs and RPC health after applying it.
For an externally managed router, run `make check-config` and restart it through
its existing deployment process.

The API rereads the file for each request. The Upstreams page refreshes config
every minute; its refresh/Try again controls reread it immediately. This page
describes **saved configuration**, which can change before the router is restarted.
It does not certify that the running router has applied that configuration.

## Published images and compatibility

For prebuilt, versioned images, set `DASHBOARD_API_IMAGE`, `DASHBOARD_WEB_IMAGE`
and `SR_CONFIG_BUILD=0` before invoking the same commands. Both images must come
from the same dashboard release. `SR_ROUTER_IMAGE` and `SR_SPEC` can be pinned
independently. `SR_COMPOSE_OVERRIDE` optionally adds a site-specific Compose file
(for example, ports). [Docker Compose 2.24.4 or newer](https://docs.docker.com/reference/compose-file/merge/#replace-value) is required.

Existing `docker compose up`, `SR_CONFIG_HOST` file mounts and Helm deployments
remain supported. The new script resolves `SR_CONFIG_HOST` into a directory and
filename for `docker-compose.config.yml`. An API outside this installer may set
`ROUTER_CONFIG_FILE` to an explicit **container** path. If unset, it keeps reading
`HELM_VALUES_DIR/core/values.yml`.

Do not bake customer YAML into images or commit it. The HTTP config response
contains masked topology and an additive `configuration` status: `ready`, `empty`,
`missing`, `unreadable`, `invalid`, `unsupported` or `error`.
