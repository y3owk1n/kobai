# The runtime shape: devbox, a pnpm workspace, Hono, and one gate command

ADR-0006 chose TypeScript on Node with a REST/OpenAPI contract, and ADR-0025 chose one
`@kobai/core` package alongside the reference Project. Neither says what a contributor
installs, what serves HTTP, or what "green" means. This records those, because the first
line of application code fixes all three whether or not anyone writes them down.

- **The toolchain is managed by devbox.** `devbox.json` pins Node; nothing is expected on
  the global PATH. A contributor with devbox and Docker gets from clone to green.
- **The repository is a pnpm workspace** — `packages/*` plus `reference/`. The reference
  Project depends on `@kobai/core` as `workspace:*`, which is an ordinary versioned
  dependency wearing a local address (ADR-0001).
- **HTTP is Hono.** Core builds a `Hono` app and hands back its `fetch`; binding a port is
  the Project's job.
- **The gate is `devbox run ci`.** One command: install, Postgres up, lint, typecheck,
  build, test. Every later ticket inherits it.

## Why Hono

The dominant test seam is the public HTTP API dispatched **in-process** against a real
Postgres. Hono's application object *is* a `fetch` handler, so a test dispatches a standard
`Request` at it with no port, no listener, and no process to supervise — the same surface a
Developer calls, minus the socket. Fastify's `inject` reaches the same place through a
framework-specific back door; Express reaches it not at all without a live server.

Hono is also the seam ADR-0006's OpenAPI-from-the-implementation requirement will attach to,
and it is already Web-standard rather than Node-specific, which keeps the Admin's eventual
single-container serving (ADR-0010) uncomplicated.

## Why corepack rather than a nix-packaged pnpm

The prototype's `devbox.json` listed `nodePackages.pnpm`. That package carries its own Node
20 and prepends it to `PATH`, so **every `pnpm run` script executed on Node 20 while
`nodejs@22` sat unused** — silently, and in a repository whose source relies on Node 22
semantics. devbox's Node provides corepack, and corepack activates the pnpm pinned in
`packageManager` on the Node that devbox provides. One Node, everywhere.

## Why `dist` in `exports` while tests resolve source

`@kobai/core` publishes built JavaScript, because that is what a Project installs. Tests
alias the package to its source instead, so a test run needs no build and a stack trace
points at a real line. The `dist` path is not left unexercised: the reference Project's
build resolves it through `node_modules` exactly as a Developer's would, and its entrypoint
test runs the built artifact.

## Consequences

- `devbox run ci` requires Docker as well as devbox, because the test suite runs against a
  real Postgres and will not be given a fake (ADR-0011, ADR-0030).
- Hono's application object appears in Core's public surface as `Kobai.fetch`. Replacing the
  framework later would be a breaking change to that surface, not an internal refactor.
- Adding a package means adding a `build` and a `typecheck` script; `devbox run ci` picks it
  up with no edit, because it runs them recursively.
