# This Project

A kobai Project: a repository you own outright, with `@kobai/core` as an ordinary versioned
dependency. Everything you have customised is declared in `kobai.config.ts`.

**Before you build on anything, read
[The five Extension Points, and what kobai promises about them](https://github.com/y3owk1n/kobai/blob/main/docs/extension-points.md)**
— what is safe to depend on, what Core's semver does *not* cover, and which of the five
are proven today rather than merely promised.

The link is absolute on purpose. This file is meant to be copied into a scaffolded Project,
and a relative path into kobai's own `docs/` would not resolve from there.
