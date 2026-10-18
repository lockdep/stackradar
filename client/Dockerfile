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

# --- Dependencies (full, for the Next.js build) ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# --- Builder ---
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm build

# --- Runtime dependencies only, resolved from the same lockfile ---
# The standalone output bundles what the Next server needs; this stage exists
# for the migration Job, which runs `npx drizzle-kit migrate` against this
# same image (`drizzle-kit` lives in `dependencies` for that reason). Using
# it instead of the full install keeps the build toolchain (eslint, tailwind,
# typescript) out of the runtime image and its SBOM.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# --- Runner ---
FROM base AS runner
ENV NODE_ENV=production
# The commit this image was built from, shown beside the version on the
# admin System tab (app/api/admin/system/route.ts). CI passes it; a local
# build without it reports the package version alone.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Migration files: the cloud's deploy Job runs `npx drizzle-kit migrate`
# against this image; self-hosted installs run `scripts/migrate.mjs` from the
# entrypoint below. Both read the same chain.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --chown=nextjs:nodejs package.json drizzle.config.ts ./
COPY --chown=nextjs:nodejs drizzle ./drizzle
COPY --chown=nextjs:nodejs src/db ./src/db
# Plain-Node scripts that run on the prod-deps node_modules above: the
# in-image migrator and the locked-out-admin path for local sign-in
# (`pnpm admin:reset-password`, step 04).
COPY --chown=nextjs:nodejs scripts/migrate.mjs scripts/admin-reset-password.mjs ./scripts/
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# MIGRATE_ON_START=true migrates before `server.js`; MIGRATE_EXIT_AFTER=true
# migrates and exits. Unset (the cloud), the entrypoint just execs the CMD.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
