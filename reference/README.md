# This Project

A kobai Project: a repository you own outright, with `@kobai/core` as an ordinary versioned
dependency. Everything you have customised is declared in `kobai.config.ts`.

**Before you build on anything, read
[The five Extension Points, and what kobai promises about them](https://github.com/y3owk1n/kobai/blob/main/docs/extension-points.md)**
— what is safe to depend on, what Core's semver does *not* cover, and which of the five
are proven today rather than merely promised.

The link is absolute on purpose. This file is meant to be copied into a scaffolded Project,
and a relative path into kobai's own `docs/` would not resolve from there.

## Running this Project

You need **Node and Docker**, and nothing else.

```sh
docker compose up --build     # Postgres and this Project, on http://localhost:3000
```

That is the whole of a first run. Core applies its migrations at boot, so a fresh database
becomes a working Store with no separate step; if they fail the application exits rather than
serving traffic against a half-migrated schema, and `/health` says which it is. The Admin is
at `/admin-ui`, served by the same process on the same origin.

To work on the code rather than just run it, install first and use the scripts:

```sh
pnpm install                  # once; corepack activates the pnpm this Project pins
pnpm run db                   # just Postgres, in Docker
pnpm run dev                  # this Project on your machine, against it
pnpm run admin:dev            # the Admin with a reload loop, in a second terminal
```

`pnpm run build`, `pnpm run typecheck`, `pnpm run start` and `pnpm run db:generate` are the
rest. Every command this Project has is in `package.json`.

**The Admin needs a Merchant, and the first one is seeded at boot** from
`KOBAI_INITIAL_MERCHANT_EMAIL` and `KOBAI_INITIAL_MERCHANT_PASSWORD` — copy `.env.example` to
`.env` and fill them in. kobai has no unauthenticated write path, so there is deliberately no
way to create that first Merchant over HTTP.

## Upgrading kobai

```sh
pnpm exec kobai-upgrade --to <version>
pnpm run build
```

That is the whole of it. `kobai-upgrade` moves every `@kobai/*` range in this Project to the
version you named, installs, and then runs the codemods **that version** ships — read out of
this Project's `node_modules` after the install, so there is nothing to upgrade first. It
tells you what it found either way; a boundary with no codemods says so rather than
succeeding in silence.

One argument, and no way to skip the install: no codemod can run until the version you are
moving to is on disk, so an upgrade that installed nothing would be an upgrade that quietly
ran none. If the command exits non-zero, read what it printed — the ranges may already have
moved, and it will say what it could not finish.

**`pnpm-lock.yaml` moves with the manifests, and belongs in the same commit.** The ranges
changed, so the resolution recorded in the lockfile is out of date the moment they do — the
upgrade's install runs `--no-frozen-lockfile` for that reason, and the command's report says
so. It is the only install that does: run this in your CI and everything else there still
installs strictly from the lockfile.
