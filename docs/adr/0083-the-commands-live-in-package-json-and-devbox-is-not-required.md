# The commands live in `package.json`, and devbox is not required

Every command this repository has is a `package.json` script, run with pnpm. `devbox.json`
keeps `nodejs@22` and the corepack line and **declares no scripts at all** — it is one
maintainer's Node provisioner and nothing else. Nothing in the gate, in CI, in a test, in the
prose, or in a generated Project refers to devbox.

This supersedes two of
[ADR-0031](./0031-the-runtime-shape-devbox-a-pnpm-workspace-hono-and-one-gate.md)'s four
clauses — *"the toolchain is managed by devbox"* and *"the gate is `devbox run ci`"*. Its
pnpm-workspace and Hono clauses are untouched, and the gate is still one command; it is now
`pnpm run ci`.

## What was wrong

devbox arrived to solve a small problem — a maintainer who does not install Node globally
wanted a pinned one — and became the repository's interface. The root `package.json` carried
a note saying it had no scripts *on purpose*, because "every command lives in devbox.json, so
there is one list rather than two that drift." That reasoning is sound and it was applied to
the wrong file. The list ended up in the one place a contributor arriving from any other
TypeScript repository would not look, behind a tool they had no reason to have.

Three things followed from it, and none is about devbox being bad:

- **There was no supported path without devbox.** Not an inconvenient one — an absent one.
  CI installed devbox too, so "it works with plain Node" was a claim nothing tested.
- **The generated Project shipped devbox as well.** `create-kobai` wrote a `devbox.json` and
  a README saying `devbox run up`, which makes jetify a dependency of running a store a
  Developer owns outright under
  [ADR-0001](./0001-customisation-lives-in-a-project-not-a-fork.md). A contributor can work
  around a tool they dislike; a Developer cannot work around one baked into the artifact they
  were handed.
- **The unusual container attracted unusual machinery.** `scripts/require-install.sh` exists
  in three hand-synced copies, with a test holding them identical, because `devbox run lint`
  in a fresh checkout failed with `Command "biome" not found` (#133) and that was judged too
  confusing to leave. Under `pnpm run lint` the same failure is the one every JavaScript
  developer has already learned means *run install* — so all three copies, the prefix on
  every script, and `tests/a-fresh-checkout-is-told-what-to-run.test.ts` go with it.

## The one-list rule inverts, and is asserted rather than trusted

`package.json` is now the list. The property ADR-0031 wanted — one list, no drift — survives
by being enforced from the other side: **a test asserts `devbox.json` declares no `scripts`
key.** That forbids the whole class rather than an instance, so a second command list cannot
quietly regrow, and it is strictly stronger than the note it replaces.

Two guardrails have to move with the commands or they stop guarding anything, because both
read a file that is about to be empty:

- **`tests/no-push-script.test.ts`** — [ADR-0030](./0030-generate-and-migrate-only-never-drizzle-kit-push.md)'s
  primary control is that `drizzle-kit push` is never *available*. It now scans the root and
  every package manifest's real `scripts` entries. It also loses its cleverest part: devbox
  turned every key into a script and ate the leading slashes, so a `"//db:push"` key
  *became* the forbidden command (#30). `package.json` has never had that hazard — npm
  attaches no meaning to such a key — so the `"// db:push"` explanations sitting in all six
  manifests stay valid documentation, and #30 becomes history rather than a standing rule.
- **`tests/the-lint-gate-fails-below-error.test.ts`** — [ADR-0039](./0039-the-lint-gate-fails-on-every-finding.md)'s
  assertion that `lint` and the gate's lint step are the *identical* biome invocation. Same
  assertion, `package.json` instead.

## The gate stays one command

`pnpm run ci` is `lint && typecheck && build && test`, and CI is one step that runs it. The
tempting alternative — four separate GitHub Actions steps, for per-step timing and cleaner
annotations — was rejected because it makes CI's step list a **second definition of green**
that can drift from the local composite. The property AGENTS.md actually leans on is *"if it
passes locally it passes here, because it is the same command"*, and splitting breaks it by
construction.

It loses its leading `pnpm install --frozen-lockfile`. A gate that installs itself is the
devbox-shaped thing; under the standard flow you install and then run the gate, like
everywhere else.

## Node is pinned by `.node-version`

`devbox.json`'s `nodejs@22` can no longer be the authority, because most readers of this
repository will never open that file. `.node-version` holds `22` and is read by fnm, nvm,
nodenv, asdf and mise, and by `actions/setup-node` through `node-version-file` — so CI and
every contributor's version manager consult one file.

`.github/dependabot.yml` currently anchors its `@types/node` major-ignore to *"the devbox
Node pin"* and says to lift it *"the day the devbox Node pin moves"*. That re-anchors to
`.node-version`. The pin now exists in four places — `.node-version`, `engines`, both
Dockerfiles, and `devbox.json` — held to one major by a test, which is this repository's
usual answer to a number written more than once.

## Considered options

- **Keep devbox scripts as one-line delegates** (`"ci": "pnpm run ci"`). Rejected: it
  reintroduces the two lists the current note was written against, in the shape most likely
  to rot — a delegate that stops matching is invisible until someone runs the wrong one.
- **Delete `devbox.json` entirely.** Rejected because it solves nothing and costs the
  maintainer their Node. Provisioning-only is exactly what devbox was wanted for.
- **Document the plain path but keep CI on devbox.** Rejected: the path the gate does not
  run is the path that rots, and it would leave the whole point of this decision unproven.

## Consequences

- **`reference/devbox.json` and `packages/create-kobai/template/devbox.json` are deleted**,
  along with both `scripts/require-install.sh` copies under them and their entries in
  `packages/create-kobai/src/adaptations.ts` and the template-drift tests. A Developer's
  first command becomes `pnpm install` and `docker compose up`.
- **CI swaps `jetify-com/devbox-install-action` for `actions/setup-node`** with
  `node-version-file: .node-version`, then `corepack enable`,
  `pnpm install --frozen-lockfile`, then `pnpm run ci`.
- **AGENTS.md §Development loses roughly its devbox half.** Prose explaining machinery that
  no longer exists is worse than absent — a map of a demolished building — so it is deleted
  rather than preserved, and the reasoning lives here and in ADR-0084. Two findings are
  carried forward into live prose because they still bite: `drizzle-kit push` (ADR-0030,
  untouched by any of this) and the `pg` two-decoders rule (ADR-0084).
- **Docker still is required**, unchanged. ADR-0031's consequence stands: the suite runs
  against a real Postgres and will not be given a fake.
