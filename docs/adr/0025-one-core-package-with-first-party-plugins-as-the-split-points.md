# One Core package, with first-party Plugins as the split points

Core ships as a single internally-modular `@kobai/core`, alongside `@kobai/admin`,
`@kobai/client` and `create-kobai`. First-party Plugins are separate packages under a
`@kobai/plugin-*` convention. Core is split into finer packages only once its seams are
known from use, not guessed in advance.

## Why not split now

Package boundaries are cheap to add and expensive to guess wrong. Splitting Core before
discovering where it actually wants to come apart imposes a cross-package refactoring tax
during exactly the period when refactoring is most frequent. Medusa shipped v1 as one
package and split into modules in v2 after learning the seams; that order is right, and the
reverse produces boundaries that fight you for years.

The first-party Plugins strengthen this rather than weaken it: they *are* the natural split
points, so Core has no need for speculative internal ones.

## Consequences

- Core's own internal modules use the same multi-migration-set machinery ADR-0004 demands
  of Plugins, so the mechanism is dogfooded continuously and a later split is mechanical
  rather than architectural.
- `create-kobai` generates a Project containing `kobai.config.ts` (the ADR-0017 Step wiring
  map), Drizzle config and the Project's migrations directory, `Dockerfile` and
  `compose.yaml`, the vendored Admin source, and `.env.example`.
