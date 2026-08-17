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

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
# devDependencies built the thing; they have no business shipping in it.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
USER node
EXPOSE 3000
# No separate migration step and no entrypoint script: Core applies its migrations at boot
# and exits non-zero if they fail, so a container that is up is a container that migrated.
CMD ["node", "reference/dist/src/server.js"]
