FROM node:24-alpine AS builder
RUN corepack enable
WORKDIR /app

ARG GIT_COMMIT=unknown
ARG APP_VERSION=0.0.0

# Copy workspace manifests + the packages this app needs, then install.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY apps/api/ apps/api/

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @sr/shared build && \
    pnpm --filter @sr/db build && \
    pnpm --filter @sr/api build

FROM node:24-alpine
RUN corepack enable
WORKDIR /app

ARG GIT_COMMIT=unknown
ARG APP_VERSION=0.0.0
ENV GIT_COMMIT=$GIT_COMMIT
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production

COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/package.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/db/package.json packages/db/
COPY --from=builder /app/packages/db/dist/ packages/db/dist/
# Drizzle applies migrations at runtime (AUTH_MODE=enabled) — ship the SQL.
COPY --from=builder /app/packages/db/migrations/ packages/db/migrations/
COPY --from=builder /app/apps/api/package.json apps/api/
COPY --from=builder /app/apps/api/dist/ apps/api/dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/apps/api/node_modules/ apps/api/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=builder /app/packages/db/node_modules/ packages/db/node_modules/

USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8000/health || exit 1
CMD ["node", "apps/api/dist/main.js"]
