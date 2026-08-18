# Plugins are npm packages, and semver covers only the promised surface

> **Amended by [ADR-0047](./0047-the-test-harness-is-promised-surface.md) and
> [ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md).**
> "And nothing else" now has exactly two exceptions: `@kobai/core/testing`, the shipped test
> harness; and **kobai's HTTP surface** — its paths and methods, the shapes it takes and
> answers with, the statuses each outcome carries, and the `reason` inside a refusal — which
> is what a storefront (ADR-0002) and the Admin (ADR-0010) have and nothing else. Everything
> else below stands, and the five Extension Points are still five: those are places Core is
> *extended*, and the HTTP surface is where Core is *consumed*.

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
