# pnpm comes from its official image, pinned by digest, for the runner's
# architecture like the build stage that copies it. Its version matches
# `packageManager` in package.json; Dependabot moves this line, so move the
# pin with it.
FROM --platform=$BUILDPLATFORM ghcr.io/pnpm/pnpm:12.23.0-alpine@sha256:f0acb1f42d79e8221951554858d4474f3a48f4e287f612ad8bfd4ed874b4ab12 AS pnpm

# The build stage runs on the runner's own architecture whatever the image
# targets: its output is plain JS and none of the api's runtime dependencies
# is a native module, so BuildKit runs it once for linux/amd64,linux/arm64.
FROM --platform=$BUILDPLATFORM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder
# pnpm's native binary and the node-gyp it uses for native builds. A pnpm
# that is not the one `packageManager` pins fails the build rather than
# downloading the pinned one.
COPY --from=pnpm /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/$bin" "/usr/local/bin/$bin"; done
ENV pnpm_config_pm_on_fail=error
WORKDIR /app

# Lockfile and manifests first, sources after: a code-only commit reuses the
# install layer. (`pnpm fetch` would pull every lockfile package into the
# store, the other apps' included.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY apps/api/ apps/api/

RUN pnpm --filter @sr/shared build && \
    pnpm --filter @sr/db build && \
    pnpm --filter @sr/api build

# Production tree for the runtime stage: the api's `files` (dist), its
# workspace packages (@sr/db ships dist + migrations) and their production
# dependencies, at the versions the workspace lockfile pins (deploy writes
# them to its own pnpm-lock.yaml). Not `--legacy`: under pnpm 12 that path
# re-resolves and drops the tslib the lockfile gives the AWS SDK.
# No devDependencies, so NODE_ENV=development (pino-pretty transport) can't boot.
RUN pnpm --filter @sr/api deploy --prod /app/deploy

# Runtime stage, built once per target architecture. Keep it free of RUN:
# the CI builder has no QEMU, so a RUN here fails on arm64 with "exec format
# error". COPY, ENV, USER and CMD need no emulation.
# Runtime package preparation runs on the builder, while apk writes the
# target architecture's root without executing its scripts. Final stages stay
# free of RUN and need no QEMU. Only the Node binary/entrypoint cross from the
# Node image: its unused npm dependency tree never enters production.
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runtime-node
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime-alpine
FROM --platform=$BUILDPLATFORM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime-files
ARG TARGETARCH
COPY --from=runtime-alpine / /runtime/
RUN case "$TARGETARCH" in amd64) apk_arch=x86_64 ;; arm64) apk_arch=aarch64 ;; *) exit 1 ;; esac && \
    apk --root /runtime --arch "$apk_arch" --no-scripts add --no-cache \
      libgcc=15.2.0-r5 libstdc++=15.2.0-r5 libatomic=15.2.0-r5 zlib=1.4-r0 && \
    mkdir -p /runtime/home/node && chown 1000:1000 /runtime/home/node

FROM scratch AS runtime-base
COPY --from=runtime-files /runtime/ /
COPY --from=runtime-node /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime-node /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=runtime-node /etc/passwd /etc/group /etc/
ENTRYPOINT ["docker-entrypoint.sh"]
FROM runtime-base
WORKDIR /app

ARG GIT_COMMIT=unknown
ARG APP_VERSION=0.0.0
ENV GIT_COMMIT=$GIT_COMMIT
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production

# The layout compose and the helm chart address: apps/api/dist/main.js,
# with the tree's node_modules inside apps/api.
COPY --from=builder /app/deploy/ apps/api/

USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8000/health || exit 1
CMD ["node", "apps/api/dist/main.js"]
