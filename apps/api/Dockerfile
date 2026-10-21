# The build stage runs on the runner's own architecture ($BUILDPLATFORM)
# whatever the image targets: its output is plain JS and none of the api's
# runtime dependencies is a native module (bcryptjs and postgres are pure
# JS). BuildKit then runs the stage ONCE for a linux/amd64,linux/arm64 build
# instead of once per architecture under QEMU, where the tsc builds took
# 139 s against 14 s native (MAG-4483).
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder
RUN corepack enable
WORKDIR /app

# Layers ordered by how often they change: the lockfile and the package
# manifests drive the install, the sources come after it, so a code-only
# commit reuses the install layer from the cache. (Not `pnpm fetch`: it
# imports every package in the lockfile into the virtual store, the other
# apps' included, and nothing prunes them afterwards.)
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

# A self-contained production tree for the runtime stage: the api's own
# `files` (dist), its workspace packages (@sr/db ships dist + migrations)
# and their production dependencies only, about 95 MB against the 283 MB
# the full workspace node_modules weigh. `pnpm install --prod` is no help
# here: on pnpm 10 it drops the top-level links but leaves every package in
# the virtual store. `--legacy` keeps the pre-pnpm-10 copy semantics, which
# the symlinked workspace (no inject-workspace-packages) needs. The tree has
# no devDependencies, so NODE_ENV=development, which asks for the dev-only
# pino-pretty log transport (src/app.ts), is for the dev stack, not this
# image; it runs with NODE_ENV=production.
RUN pnpm --filter @sr/api deploy --legacy --prod /app/deploy

# Runtime stage, built once per target architecture. Keep it free of RUN:
# the CI builder has no QEMU, so a RUN here fails on arm64 with "exec format
# error". COPY, ENV, USER and CMD need no emulation.
FROM node:24-alpine
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
