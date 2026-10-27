# ---- builder: install full deps and compile TypeScript ----
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runner: production dependencies only, non-root ----
# node:22-slim (Debian): no extra OS packages needed. The image bundles the
# paired SQL migrations and applies them on boot (dist/serve.js runs migrateUp
# before listening), so there is no separate migration step in the stack.
FROM node:22-slim AS runner
ENV NODE_ENV=production \
    GA_HOST=0.0.0.0 \
    GA_SQLITE_PATH=/data/growth-agent.db \
    GA_GSC_TOKEN_DIR=/data/gsc-tokens \
    GA_REPORT_DIR=/data/reports
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder --chown=node:node /app/dist ./dist
# Paired migrations are read at runtime from db/migrations (src/storage/migrate.ts).
COPY --chown=node:node db ./db
# Site configs are read at runtime by the batch CLI (dist/cli/batch.js) and by
# the offline smoke; a compose bind mount over /app/config/sites overrides
# these so an operator can add a site without rebuilding the image.
COPY --chown=node:node config ./config
# Offline connector modes replay these deterministic fixtures (the default
# GA_*_MODE=off deployment still runs the full pipeline without network).
COPY --chown=node:node tests/fixtures ./tests/fixtures
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# node:sqlite is still behind the experimental flag on Node 22.
CMD ["node", "--experimental-sqlite", "dist/serve.js"]
