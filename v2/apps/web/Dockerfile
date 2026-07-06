FROM node:24-alpine AS builder
RUN corepack enable
WORKDIR /app

# NEXT_PUBLIC_* are baked at build time into the client bundle. The browser
# reaches the API directly, so this must be the public URL of the api.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ARG NEXT_PUBLIC_LOCAL_MODE=false

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/

RUN pnpm install --frozen-lockfile

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_LOCAL_MODE=$NEXT_PUBLIC_LOCAL_MODE
RUN pnpm --filter @sr/shared build && \
    pnpm --filter @sr/web build

FROM node:24-alpine
WORKDIR /app

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static apps/web/.next/static
COPY --from=builder /app/apps/web/public apps/web/public

ENV NODE_ENV=production
ENV PORT=3000
USER node
EXPOSE 3000
# /api/config always answers 200 regardless of AUTH_MODE (with auth enabled,
# /overview 307s to /login, which busybox wget handles inconsistently).
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/config || exit 1
CMD ["node", "apps/web/server.js"]
