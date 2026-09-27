# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS builder
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
# The root packageManager is the single source of the exact pnpm version.
RUN npm install --global "$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).packageManager')"
RUN pnpm install --frozen-lockfile --filter @trailer-arena/server... --filter trailer-arena
COPY apps/server apps/server
COPY packages/shared packages/shared
COPY scripts/materialize-shared.mjs scripts/materialize-shared.mjs
RUN pnpm build:server
# Legacy deploy supports this non-injected pnpm 11 workspace; only production deps remain.
RUN pnpm --filter @trailer-arena/server deploy --legacy --prod /out/server
RUN node scripts/materialize-shared.mjs /out/server

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=node:node /out/server/ ./
COPY --chown=node:node scripts/healthcheck.mjs ./scripts/healthcheck.mjs
USER node
# Metadata only. The listener and health check use the supplied PORT environment variable.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "dist/main.js"]
