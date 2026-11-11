# The build stage runs on the runner's own architecture whatever the image
# targets: its output is plain JS and none of the api's runtime dependencies
# is a native module, so BuildKit runs it once for linux/amd64,linux/arm64.
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder
RUN corepack enable
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
# dependencies; `--legacy` is what pnpm 10 needs for a symlinked workspace.
# No devDependencies, so NODE_ENV=development (pino-pretty transport) can't boot.
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
