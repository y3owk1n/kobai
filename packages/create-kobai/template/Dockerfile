# This Project, as one container.
#
# The build context is this Project's own directory, because that is all it needs: kobai
# arrives from a registry as an ordinary dependency, so there is no workspace to copy in and
# no monorepo root to build from (ADR-0001, ADR-0034).
FROM node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
# Not `--frozen-lockfile`: a Project that has never been installed has no `pnpm-lock.yaml`,
# and `--frozen-lockfile` fails rather than creating one — so `docker compose up` would fail
# on a freshly generated Project, which is the first thing anyone does. Once the lockfile is
# committed this honours it exactly as the stricter flag would.
RUN pnpm install
# Builds the Admin's bundle and this Project's TypeScript. One command, because the Admin is
# a workspace package of this Project with its own `build` script (ADR-0033).
#
# `--include-workspace-root` is what makes it build *both*. This Project is the root of its
# own workspace and `pnpm -r` skips the root, so without the flag the Admin builds, the
# command succeeds, and the image ends up with no `dist/src/server.js` in it at all.
RUN pnpm -r --include-workspace-root build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# devDependencies built the thing; they have no business shipping in it. The whole frontend
# toolchain is a devDependency of the `admin` package for exactly this reason — what the
# runtime needs is the bytes `vite build` produced, not the tools that produced them.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
USER node
EXPOSE 3000
# No separate migration step and no entrypoint script: Core applies its migrations at boot
# and exits non-zero if they fail, so a container that is up is a container that migrated.
CMD ["node", "dist/src/server.js"]
