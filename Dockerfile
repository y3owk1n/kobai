# The reference Project, as one container. Built from the monorepo root because the Project
# depends on @kobai/core from this workspace; a generated Project depends on it from npm and
# will not need the extra context.
FROM node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build

# devDependencies built the thing; they have no business shipping in it — and the pruning
# has to happen **here**, in the stage that is thrown away.
#
# `pnpm install --prod` over an existing `node_modules` rewrites the symlink farm and leaves
# `node_modules/.pnpm` — every devDependency's bytes — exactly where it was. It relinks; it
# does not prune. So the runtime stage copying the build stage's whole `/repo` and then
# running that command shipped `drizzle-kit`, `vitest`, `biome`, `typescript`, React, Vite
# and Tailwind to production: 933 MB of image, 509 MB of it `node_modules/.pnpm`, against
# 384 KB of built Admin (#12).
#
# Deleting the store first is what makes the second install genuinely production-only.
# Doing it in this stage is what keeps those bytes out of any layer the runtime stage
# copies — a `rm -rf` *after* a `COPY --from` hides them in a lower layer rather than
# removing them, and the image is the same size.
RUN rm -rf node_modules packages/*/node_modules reference/node_modules reference/admin/node_modules \
  && pnpm install --frozen-lockfile --prod --ignore-scripts

# The Admin ships as the bytes `vite build` produced and nothing else. Its source is a
# Developer's to edit (ADR-0033) and its toolchain is entirely a devDependency, so neither
# belongs in a runtime image; `dist/` and the manifest `import.meta.resolve` finds it
# through are the whole of what `src/admin-assets.ts` needs. Discovered rather than listed,
# so a new config file in that package does not quietly start shipping.
RUN find reference/admin -mindepth 1 -maxdepth 1 \
  ! -name dist ! -name package.json ! -name node_modules -exec rm -rf {} +

# Neither of these is reachable from the entrypoint: `@kobai/client` is a devDependency of
# the Admin's build and `create-kobai` scaffolds Projects rather than running inside one.
# `tests/` is the repository's, not the Project's.
RUN rm -rf tests packages/client packages/create-kobai

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
USER node
EXPOSE 3000
# No separate migration step and no entrypoint script: Core applies its migrations at boot
# and exits non-zero if they fail, so a container that is up is a container that migrated.
CMD ["node", "reference/dist/src/server.js"]
