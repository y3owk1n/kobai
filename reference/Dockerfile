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

# devDependencies built the thing; they have no business shipping in it. The whole frontend
# toolchain is a devDependency of the `admin` package for exactly this reason — what the
# runtime needs is the bytes `vite build` produced, not the tools that produced them.
#
# **The pruning has to happen here, in the stage that is thrown away.** `pnpm install --prod`
# over an existing `node_modules` rewrites the symlink farm and leaves `node_modules/.pnpm` —
# every devDependency's bytes — exactly where it was. It relinks; it does not prune. Running
# it in the runtime stage, over a `COPY` of the build stage's whole tree, therefore shipped
# `drizzle-kit`, React, Vite and Tailwind to production and made no difference to the size
# (#12). Deleting the store first is what makes the second install production-only, and a
# `rm -rf` after the `COPY` would not do it either — a lower layer still carries the bytes.
#
# `--frozen-lockfile` here and not on the install above: by this point the install above has
# written a `pnpm-lock.yaml` even if the Project arrived without one, so the production tree
# is resolved from the same lockfile the tree that was just built came from. Without it the
# image could ship a resolution nothing tested.
RUN rm -rf node_modules admin/node_modules \
  && pnpm install --frozen-lockfile --prod --ignore-scripts

# The Admin ships as the bytes `vite build` produced and nothing else. Its source is yours to
# edit (ADR-0033) and its config and toolchain are build inputs, so what the running process
# needs is `dist/` and the manifest `src/admin-assets.ts` resolves it through. Discovered
# rather than listed, so a new config file in that package does not quietly start shipping.
RUN find admin -mindepth 1 -maxdepth 1 \
  ! -name dist ! -name package.json ! -name node_modules -exec rm -rf {} +

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000
# No separate migration step and no entrypoint script: Core applies its migrations at boot
# and exits non-zero if they fail, so a container that is up is a container that migrated.
CMD ["node", "dist/src/server.js"]
