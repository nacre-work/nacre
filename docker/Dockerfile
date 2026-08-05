# One image, three entry points.
#
# api, mcp, and worker share a dependency tree and a build; shipping three
# images would mean three things to keep in step and three chances for one of
# them to lag a security fix. The command decides which one runs.

# Pinned to the platform doing the building, never the one being built for.
#
# This stage installs, compiles TypeScript and bundles the admin UI, and every
# one of its outputs is JavaScript — the production dependency tree is `pg`,
# `jose` and the Qdrant client, none of which carry a native binary, and the
# compilers that do (esbuild, lightningcss) are development dependencies the
# `--prod` install below removes. So there is nothing here for an architecture
# to disagree about, and running it under emulation would buy a slower build and
# an identical result. The runtime stage stays on the target platform, which is
# what makes the image actually arm64.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
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

# The company admin UI, on one origin with the API.
#
# `packages/admin` is static files — `pnpm build` above already produced them —
# so serving it is nginx and nothing else. It is a separate stage rather than a
# separate Dockerfile so it reuses the build above rather than installing and
# compiling the workspace a second time, and it sits before `runtime` on purpose:
# the last stage is the default build target, and that has to stay the node image
# the api/mcp/worker services run.
FROM nginx:alpine AS web
COPY --from=build /app/packages/admin/dist /usr/share/nginx/html
# A template, not a config: the image's entrypoint renders anything under
# /etc/nginx/templates into /etc/nginx/conf.d. That is what lets one image serve
# Compose, where the API is `api:8080`, and Kubernetes, where it is a Service
# name — instead of hardcoding the first and being undeployable in the second.
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template

# Only these two are substituted. Left unset, the entrypoint replaces every
# `$name` in the template, and nginx's own `$host`, `$scheme`, `$uri` and
# `$proxy_add_x_forwarded_for` would be rendered as empty strings — a config
# that loads and forwards nothing useful.
ENV NGINX_ENVSUBST_FILTER='^(NACRE_API_UPSTREAM|NGINX_PORT)$'
# Compose's shape as the default, because that is the one anybody meets first.
ENV NACRE_API_UPSTREAM=api:8080
ENV NGINX_PORT=80

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
