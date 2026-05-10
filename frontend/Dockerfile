# Build stage
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

ENV CI=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Build the application (env vars will be available at runtime via API route)
RUN pnpm build

# Production stage
FROM node:20-alpine AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

WORKDIR /app

COPY --from=builder --chown=nextjs:nodejs /app /app

# Environment variables can be set at runtime via docker-compose or docker run
# These will be available to the Next.js API route that serves runtime config
ENV NODE_ENV=production
ENV PORT=3000

# Default values (can be overridden at runtime)
ENV NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_DOMAIN=localhost
ENV NEXT_PUBLIC_PORT=3000
ENV NEXT_PUBLIC_PROMETHEUS_URL=http://localhost:9090

EXPOSE 3000

USER nextjs

CMD ["pnpm", "start"]
