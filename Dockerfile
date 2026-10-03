# ── Stage 1: Build ────────────────────────────────────────────────────
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/types/package.json packages/types/
COPY packages/tunnel-core/package.json packages/tunnel-core/
COPY packages/i18n/package.json packages/i18n/
COPY packages/db/package.json packages/db/

RUN npm ci --prefer-offline

COPY tsconfig.base.json ./
COPY packages/types/ packages/types/
COPY packages/tunnel-core/ packages/tunnel-core/
COPY packages/i18n/ packages/i18n/
COPY packages/db/ packages/db/
COPY scripts/apply-migrations.mjs scripts/create-admin.mjs scripts/
COPY apps/web/ apps/web/

ENV TURBO_DISABLE=true
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────────────
FROM node:22-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl openssh-client sshpass iputils-ping && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
# Engine binaries (gost/backhaul/frp), tunnel configs, and SQLite live here.
# Mount a volume: docker run -v xistance-data:/data ...
ENV XT_DATA_DIR=/data

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# /data must belong to the runtime user, and the VOLUME declaration must come
# AFTER the chown: a fresh anonymous or named volume is initialised from the
# image's directory ownership, so declaring VOLUME first pins every new volume
# to root:root and SQLite fails with "Error code 14: Unable to open the
# database file". Verified on both linux/amd64 and linux/arm64.
RUN mkdir -p /data && chown nextjs:nodejs /data
VOLUME /data

WORKDIR /app

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public apps/web/public

# The standalone trace does not include the migration SQL or the applier that
# runs it (the release installer stages both explicitly). Without these the
# server starts against a 0-byte database and every query fails with
# "table main.Tunnel does not exist". Mirrors what
# scripts/stage-release-artifact.ts stages for the tarball.
COPY --from=builder --chown=nextjs:nodejs /app/packages/db/prisma/migrations packages/db/prisma/migrations
COPY --from=builder --chown=nextjs:nodejs /app/scripts/apply-migrations.mjs apply-migrations.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/create-admin.mjs create-admin.mjs

# Apply migrations before serving, then hand off to the server. Idempotent, so
# a restart against an existing volume is a no-op.
#
# The database filename must match what packages/db/src/index.ts resolves:
# DATABASE_URL if set, else ${XT_DATA_DIR}/xistance.db (see resolveDatabaseUrl).
# Migrating "app.db" here left the app opening a separate empty xistance.db and
# failing every query with P2021, so derive the path from the same rule rather
# than hardcoding a second name.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -e' \
      'DB_NAME=$(printf "%s" "${DATABASE_URL:-}" | sed -n "s|^file:.*/||p")' \
      '[ -n "$DB_NAME" ] || DB_NAME=xistance.db' \
      'node /app/apply-migrations.mjs --database "file:${XT_DATA_DIR}/${DB_NAME}" --migrations /app/packages/db/prisma/migrations' \
      'exec node apps/web/server.js' \
      > /app/docker-entrypoint.sh \
      && chmod +x /app/docker-entrypoint.sh

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["/app/docker-entrypoint.sh"]
