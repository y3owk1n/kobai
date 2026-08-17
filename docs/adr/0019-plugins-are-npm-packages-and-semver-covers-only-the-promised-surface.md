# Plugins are npm packages, and semver covers only the promised surface

> **Amended by [ADR-0047](./0047-the-test-harness-is-promised-surface.md).** "And nothing
> else" now has exactly one exception: `@kobai/core/testing`, the shipped test harness, is
> promised surface too. Everything else below stands, and the five Extension Points are still
> five.

Plugins are ordinary npm packages declaring a `peerDependency` on Core; local unpublished
ones work through the workspace protocol. **There is no kobai registry and will not be
one** — npm is the registry. Core's semver covers the five Extension Points of ADR-0003
**and nothing else**: a Core minor may freely change any internal a Developer could
technically reach.

## Why no registry

A plugin marketplace is a v3 fantasy that has consumed better-resourced projects than this
one. npm already solves discovery, versioning, and distribution, and a Project installing a
Plugin should look exactly like installing any other dependency.

## Why the semver caveat needs shouting

This is an unusual and easily-missed promise. A Developer who reaches into a Core internal,
gets burned by a minor release, and calls it a broken promise is behaving reasonably unless
the boundary was impossible to miss. Documenting it once in a reference page is not enough —
it belongs wherever a Developer is likely to cross the line.

## Consequences

The workspace protocol is the path by which kobai's own made-to-order Plugin (ADR-0014)
begins life inside the first Project and is only published if it ever needs to be.
