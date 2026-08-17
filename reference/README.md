# This Project

A kobai Project: a repository you own outright, with `@kobai/core` as an ordinary versioned
dependency. Everything you have customised is declared in `kobai.config.ts`.

**Before you build on anything, read
[The five Extension Points, and what kobai promises about them](https://github.com/y3owk1n/kobai/blob/main/docs/extension-points.md)**
— what is safe to depend on, what Core's semver does *not* cover, and which of the five
are proven today rather than merely promised.

The link is absolute on purpose. This file is meant to be copied into a scaffolded Project,
and a relative path into kobai's own `docs/` would not resolve from there.

## Upgrading kobai

```sh
pnpm exec kobai-upgrade --to <version>
pnpm -r --include-workspace-root build
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
