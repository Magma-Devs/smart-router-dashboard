# pnpm comes from its official image, pinned by digest, for the runner's
# architecture like the build stage that copies it. Its version matches
# `packageManager` in package.json; Dependabot moves this line, so move the
# pin with it.
FROM --platform=$BUILDPLATFORM ghcr.io/pnpm/pnpm:12.18.0-alpine@sha256:937d5b248145cd59aaf3d78dd0fd45f95e65b942585c370a0a11d53ab937ed98 AS pnpm

# The build stage runs on the runner's own architecture whatever the image
# targets: its output is plain JS and the web loads no native module at
# runtime, so BuildKit runs it once for linux/amd64,linux/arm64.
FROM --platform=$BUILDPLATFORM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder
# pnpm's native binary and the node-gyp it uses for native builds. A pnpm
# that is not the one `packageManager` pins fails the build rather than
# downloading the pinned one.
COPY --from=pnpm /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/$bin" "/usr/local/bin/$bin"; done
ENV pnpm_config_pm_on_fail=error
WORKDIR /app

# NEXT_PUBLIC_* are baked at build time into the client bundle. The browser
# reaches the API directly, so this must be the public URL of the api.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ARG NEXT_PUBLIC_LOCAL_MODE=false

# Lockfile and manifests first, sources after: a code-only commit reuses the
# install layer. (`pnpm fetch` would pull every lockfile package into the
# store, the other apps' included.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_LOCAL_MODE=$NEXT_PUBLIC_LOCAL_MODE
RUN pnpm --filter @sr/shared build && \
    pnpm --filter @sr/web build

# Next traces sharp into the standalone output for the build host's
# architecture only, and `images.unoptimized` means nothing ever loads it,
# so neither image carries it.
RUN cd apps/web/.next/standalone/node_modules/.pnpm && \
    rm -rf sharp@* @img+* node_modules/sharp node_modules/@img next@*/node_modules/sharp

# Runtime stage, built once per target architecture. Keep it free of RUN:
# the CI builder has no QEMU, so a RUN here fails on arm64 with "exec format
# error". COPY, ENV, USER and CMD need no emulation.
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
WORKDIR /app

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static apps/web/.next/static
COPY --from=builder /app/apps/web/public apps/web/public

ENV NODE_ENV=production
ENV PORT=3000
# Next standalone server.js defaults to HOSTNAME=localhost, which resolves to
# ::1 (IPv6) in this image — so the IPv4 healthcheck below (127.0.0.1) gets
# "connection refused" and the container reports unhealthy even while serving
# fine on the published port. Bind all interfaces so both paths work.
ENV HOSTNAME=0.0.0.0
USER node
EXPOSE 3000
# /api/config always answers 200 regardless of AUTH_MODE (with auth enabled,
# /metrics 307s to /login, which busybox wget handles inconsistently).
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/config || exit 1
CMD ["node", "apps/web/server.js"]
