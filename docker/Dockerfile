# One image, three entry points.
#
# api, mcp, and worker share a dependency tree and a build; shipping three
# images would mean three things to keep in step and three chances for one of
# them to lag a security fix. The command decides which one runs.

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

# A build is not an interactive session, and pnpm needs telling.
#
# The second install below switches the tree from full to production-only, which
# means pnpm removes `node_modules` and lays it down again. It refuses to do that
# without confirmation when there is no TTY — and a `docker build` never has one,
# so the step failed with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY on every
# machine, every time. Not an environment quirk: this image could not be built by
# anyone.
#
# `CI=true` is what pnpm's own message suggests and is true of every context this
# stage runs in. It is on the build stage only; the runtime image never sees it.
ENV CI=true

# Manifests first, so a source-only change reuses the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json    packages/core/
COPY packages/api/package.json     packages/api/
COPY packages/mcp/package.json     packages/mcp/
COPY packages/worker/package.json  packages/worker/
COPY packages/sdk/package.json     packages/sdk/
COPY packages/admin/package.json   packages/admin/
RUN pnpm install --frozen-lockfile

COPY tsconfig*.json ./
COPY packages packages
RUN pnpm build

# Drop everything the runtime does not need, including the compilers.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Never root. The container reads documents for a living.
RUN addgroup -S nacre && adduser -S nacre -G nacre
USER nacre

COPY --from=build --chown=nacre:nacre /app/node_modules node_modules
COPY --from=build --chown=nacre:nacre /app/packages packages
COPY --from=build --chown=nacre:nacre /app/package.json ./

# Liveness only — it touches no dependency. A healthcheck that calls Postgres
# turns one slow database into a cascading restart loop.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/api/dist/main.js"]
