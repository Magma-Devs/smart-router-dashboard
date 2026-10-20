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

# The IAM Roles Anywhere credential helper, for a managed deployment that sends
# mail through SES as a certificate rather than an access key: the chart renders
# an AWS config file whose profile runs it as `credential_process`, and the SES
# client (built with no explicit credentials) resolves one-hour credentials
# through the SDK's default chain; `aws-credential-process.test.ts` pins that.
#
# Built from source with cgo ON against musl: the helper's PKCS#11 package
# needs cgo (a cgo-off build does not compile), and AWS's release binaries are
# linked against glibc, which this image's musl cannot load. Like the builder
# above it runs on the runner's own architecture: `xx` hands clang the target's
# musl sysroot, so the arm64 helper is cross-compiled, not emulated.
# `xx-verify` checks the binary is for its target, the one for the runner's
# own architecture also runs `version` here, and the arm64 one runs it in CI's
# smoke-arm64 job.
FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.10.0 AS xx
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS signing-helper
COPY --from=xx / /
RUN apk add --no-cache clang lld
ARG TARGETPLATFORM
RUN xx-apk add --no-cache gcc musl-dev
ARG AWS_SIGNING_HELPER_VERSION=1.8.6
# A cross-compiled `go install` lands in /go/bin/<os>_<arch>/, a native one in
# /go/bin/; each stage instance builds exactly one.
RUN CGO_ENABLED=1 xx-go install -trimpath \
      -ldflags "-s -w -X github.com/aws/rolesanywhere-credential-helper/cmd.Version=${AWS_SIGNING_HELPER_VERSION}" \
      "github.com/aws/rolesanywhere-credential-helper@v${AWS_SIGNING_HELPER_VERSION}" \
 && install -D "$(find /go/bin -type f -name rolesanywhere-credential-helper)" /out/aws_signing_helper \
 && xx-verify /out/aws_signing_helper \
 && if ! xx-info is-cross; then /out/aws_signing_helper version; fi

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

COPY --from=signing-helper /out/aws_signing_helper /usr/local/bin/aws_signing_helper

USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8000/health || exit 1
CMD ["node", "apps/api/dist/main.js"]
