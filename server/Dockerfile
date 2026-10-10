# syntax=docker/dockerfile:1
# pnpm is resolved by corepack from the `packageManager` field in package.json,
# so the build uses one pinned version instead of whatever `pnpm@latest`
# happens to resolve to that day. The base image is pinned by digest for the
# same reason: `22-alpine` is a moving tag, so two builds of the same commit
# could otherwise ship different base layers — and different CVEs.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# --- Dependencies (full, for the TypeScript build) ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# --- Builder ---
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# --- Runtime dependencies only, resolved from the same lockfile ---
# Shipping the build toolchain (typescript, vitest, tsx, testcontainers) in
# the runtime image would put packages the server never loads into its own
# SBOM. `drizzle-kit` lives in `dependencies` on purpose: the migration Job
# runs `npx drizzle-kit migrate` against this same image.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# --- Render/scan binaries ---
# The worker's two subprocesses (docs/proposals/measuring-candidate-charts.md):
# `helm template` renders candidate charts, `syft` scans candidate images.
# Pinned by version AND checksum — the worker feeds their output into rows
# every tenant's suggestions read, so "whatever the mirror served today" is
# not an acceptable provenance for either binary.
FROM base AS tools
ENV HELM_VERSION=3.22.0 \
    HELM_SHA256=1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb \
    SYFT_VERSION=1.54.0 \
    SYFT_SHA256=54a87372498168b2d033e876fd41fa4e8035b872699e525a57046e1f2f09c860
RUN wget -q "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" -O /tmp/helm.tgz && \
    echo "${HELM_SHA256}  /tmp/helm.tgz" | sha256sum -c - && \
    tar -xzf /tmp/helm.tgz -C /tmp && \
    install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm && \
    wget -q "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_amd64.tar.gz" -O /tmp/syft.tgz && \
    echo "${SYFT_SHA256}  /tmp/syft.tgz" | sha256sum -c - && \
    tar -xzf /tmp/syft.tgz -C /tmp syft && \
    install -m 0755 /tmp/syft /usr/local/bin/syft

# --- Runner ---
FROM base AS runner
ENV NODE_ENV=production
# The commit this image was built from, reported as part of `serverVersion`
# by POST /internal/match (src/lib/server-version.ts). CI passes it; a local
# build without it reports the package version alone.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 expressjs

COPY --from=tools /usr/local/bin/helm /usr/local/bin/helm
COPY --from=tools /usr/local/bin/syft /usr/local/bin/syft

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
# Copy JSON schema files (TypeScript doesn't copy non-ts files to dist)
COPY --from=builder /app/src/schemas ./dist/src/schemas
# The Drizzle chain and config: the cloud's deploy Job runs `npx drizzle-kit
# migrate` against this image; a self-hosted install sets MIGRATE_ON_START
# and `dist/src/db/migrate.js` applies the same files from `./drizzle` at boot.
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/src/db ./src/db

USER expressjs

EXPOSE 3001
ENV PORT=3001

CMD ["node", "dist/src/index.js"]
