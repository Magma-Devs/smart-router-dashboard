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

# The IAM Roles Anywhere credential helper, for a managed deployment that sends
# mail through SES as a certificate rather than an access key: the chart renders
# an AWS config file whose profile runs it as `credential_process`, and the SES
# client (built with no explicit credentials) resolves one-hour credentials
# through the SDK's default chain — `aws-credential-process.test.ts` pins that.
#
# Built from source, with cgo ON, on the same Alpine the runtime stage uses: the
# helper's PKCS#11 package needs cgo (a cgo-off build does not compile), and
# AWS's release binary is linked against glibc, which this image's musl cannot
# load. The `version` call on the runtime stage below is what proves the result
# runs where it ships — an image whose helper cannot run is never built.
FROM golang:1.26-alpine AS signing-helper
ARG AWS_SIGNING_HELPER_VERSION=1.8.4
RUN apk add --no-cache build-base
RUN CGO_ENABLED=1 go install -trimpath \
      -ldflags "-s -w -X github.com/aws/rolesanywhere-credential-helper/cmd.Version=${AWS_SIGNING_HELPER_VERSION}" \
      "github.com/aws/rolesanywhere-credential-helper@v${AWS_SIGNING_HELPER_VERSION}" \
 && mv /go/bin/rolesanywhere-credential-helper /usr/local/bin/aws_signing_helper

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

COPY --from=signing-helper /usr/local/bin/aws_signing_helper /usr/local/bin/aws_signing_helper
# Fails the build, not the pod, if the helper cannot run on this libc.
RUN /usr/local/bin/aws_signing_helper version

USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8000/health || exit 1
CMD ["node", "apps/api/dist/main.js"]
