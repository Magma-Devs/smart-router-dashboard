# Build stage
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DOMAIN
ARG NEXT_PUBLIC_PORT
ENV NEXT_PUBLIC_DOMAIN=${NEXT_PUBLIC_DOMAIN}
ENV NEXT_PUBLIC_PORT=${NEXT_PUBLIC_PORT}
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN pnpm build

# Production stage
FROM node:20-alpine AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY --from=builder /app /app

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DOMAIN
ARG NEXT_PUBLIC_PORT
ENV NEXT_PUBLIC_DOMAIN=${NEXT_PUBLIC_DOMAIN}
ENV NEXT_PUBLIC_PORT=${NEXT_PUBLIC_PORT}
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["pnpm", "start"]
