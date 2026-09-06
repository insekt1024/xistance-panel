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
COPY apps/web/ apps/web/

ENV TURBO_DISABLE=true
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────────────
FROM node:22-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

WORKDIR /app

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public apps/web/public

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "apps/web/server.js"]
