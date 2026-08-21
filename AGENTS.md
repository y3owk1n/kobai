# kobai

Open source e-commerce backend plus CMS.

> **Status: walking skeleton in progress.** The stack is chosen and the first slice boots —
> see [Development](#development). Everything not yet built is still undecided: do not infer
> conventions that aren't written down here, and do not invent them. If you need a decision
> that isn't recorded, that's a signal to go resolve it (see
> [Working on kobai](#working-on-kobai)) rather than to guess.

This file is the **single source of truth** for agent instructions, together with the
surface-specific files it routes to under `docs/agents/` — see
[Where the rest of it is](#where-the-rest-of-it-is-and-when-to-read-it), which is the whole
list and is not a summary of them. Every other agent config in this repo points back here —
see [Agent tool scaffold](#agent-tool-scaffold). When you learn something durable about how
kobai should be built, it belongs here, in one of those files, in `CONTEXT.md`, or in an ADR
under `docs/adr/` — not in a tool-specific file.

## Working on kobai

Work flows through the engineering skills configured below:

1. **Fog** — the way from here to a shipped thing isn't visible yet. Chart it with
   `/wayfinder`, which produces **decisions, not deliverables** as linked GitHub issues.
2. **Idea** — sharpen it with `/grill-with-docs`, which records terms in `CONTEXT.md` and
   hard-to-reverse decisions as ADRs under `docs/adr/`.
3. **Build** — `/to-spec` → `/to-tickets` → `/implement` (which drives `/tdd` and closes
   with `/code-review`).
4. **Incoming** — bug reports and feature requests you didn't write go through `/triage`.

Steps 1–3 assume a real issue tracker; this repo uses GitHub Issues.

## Development

**Prerequisites: Node 22 and Docker. Nothing else.** `.node-version` holds the pin, so fnm,
nvm, nodenv, asdf and mise all read it; `corepack enable` then activates the pnpm pinned in
`package.json`. If you would rather not install Node globally, `devbox.json` provides exactly
those two things and nothing else — it declares no scripts, and nothing in this repository is
run through it.

```sh
corepack enable        # once, on whatever Node 22 you have
pnpm install
pnpm run ci            # the gate
```

**The gate is `pnpm run ci`.** It is the single command that proves the repository is green:
lint, typecheck, build, test. Nothing is done until it passes, and no PR opens on a red one.
CI runs that one command rather than a step list of its own — a step list is a second
definition of green that can drift from the composite you run (ADR-0083). It installs
nothing: you install, then you run the gate.

**The gate fails on every finding Biome reports, at any severity** (ADR-0039). `biome ci`
exits *zero* on warnings by default, and Biome 2 re-tiered most of what Biome 1 called an
error down to `warn` or `info` — so `pnpm run lint` passes `--error-on-warnings`, and
`biome.json` lifts the 28 recommended rules that default to `info` up to `warn`, which no
flag can do. **`pnpm run ci` reaches the `lint` script rather than repeating its flags**, so
the two cannot drift; a gate stricter than the command you are told to run is a difference
that shows up nowhere until CI goes red. `pnpm run format` is the forgiving one — it rewrites
rather than reports, so it is where a finding gets fixed. Reach for it first; most findings
below `error` carry a safe fix.

Three things follow, and each has a test rather than a convention behind it:

- **What the gate lints is `.gitignore`'s question, not `biome.json`'s** (ADR-0068).
  `biome.json` sets `vcs.useIgnoreFile`, so a gitignored path is out of scope **at any
  depth** — which is what `"!.devbox"` was not: it was root-anchored, so a build run inside
  `reference/` left a generated file the gate then failed to format, naming a path that would
  not lead you to `reference/` (#203). `.scratch/` was the same bug with no ticket. So
  `files.includes` now excludes **only what git tracks** — the five generated artifacts an
  ignore file can never carry — and `tests/the-gate-lints-what-git-tracks.test.ts` fails
  naming any exclusion git tracks no file under. **An artifact directory is one edit: add it
  to `.gitignore`.** Adding it here too is the second, narrower answer that produced #203,
  and it now reddens the build. **Every `.dockerignore` obeys the same rule and cannot
  delegate it**, Docker having no `useIgnoreFile` — so a pattern naming something
  `.gitignore` names is written `**/`-first, as `**/node_modules` always was and `.env` and
  `.env.*` were not. That one had no ticket and a worse consequence than a red gate:
  `COPY . .` put any `reference/.env` into the image, and `.gitignore` is why `git status`
  would never have shown it to you.
  `tests/nothing-git-ignores-reaches-the-build-context.test.ts` derives it from `.gitignore`
  for both copies — the template's included, which follows only through
  `pnpm run template:generate`. **`.claude/worktrees/` is ignored for the same reason and is
  the sharpest case**: a harness puts a whole second checkout there, and a nested `biome.json`
  is one Biome refuses outright — so `pnpm run lint` *failed*, naming a directory you are not
  in. It is also the only entry in either ignore file with an interior slash, so it is
  anchored at the root rather than matching at every depth, and the `.dockerignore` sweep
  knows the difference.
- **A rule below the floor is a decision.** `tests/the-lint-gate-fails-below-error.test.ts`
  asks Biome for every rule's default severity *at gate time* and fails naming any enabled
  rule that resolves below `warn`. So a Biome upgrade that demotes a rule, or adds a
  recommended one at `info`, turns the build red instead of quietly widening what passes —
  which is exactly how the gate got loose in the first place (#28, #45). Answer it by
  promoting the rule to `"warn"` under its group in `biome.json`, or by turning it `"off"`
  on purpose. Do not delete the assertion.
- **`biome.json` cannot explain itself.** A comment in it stops Biome parsing its own config:
  it walks *up* to the parent checkout's and fails with "found a nested root configuration",
  naming a directory you are not in. Every explanation lives in ADR-0039, ADR-0068 or
  ADR-0033 instead.

| Command | What it does |
| --- | --- |
| `pnpm install` | **The first command in a checkout that has never installed.** There is deliberately no script by that name — one would be an npm lifecycle hook that ran during the install itself. |
| `pnpm run ci` | **The gate.** Lint, typecheck, build, test. Install first. |
| `pnpm run up` | Postgres and the reference Project — it prints the URL. `/health`, Admin at `/admin-ui`. |
| `pnpm run down` | Stop them. `pnpm run db:down` also drops the volume. |
| `pnpm run dev` | The reference Project on this machine, **watching**: an edit anywhere under `packages/*/src` or `reference/src` recompiles and restarts it. |
| `pnpm run admin:dev` | The Admin with a reload loop, beside `pnpm run dev`. See [The Admin](docs/agents/the-admin.md). |
| `pnpm run db` | Just Postgres — what the test suite needs. |
| `pnpm run browsers` | Downloads the Chromium the Admin's browser seam drives. `ci` and `test` reach this script themselves. |
| `pnpm run test` | Postgres up, build, then the whole suite. |
| `pnpm run typecheck` / `lint` / `format` / `build` | One step each. |
| `pnpm run db:generate` | Build, then generate a migration in every package whose schema changed — Core and each Plugin. |
| `pnpm run openapi:generate` | Regenerate the OpenAPI description, then the client generated from it. |
| `pnpm run template:generate` | Regenerate what `create-kobai` generates, from the reference Project. |

**A Postgres major does not upgrade a volume it finds, and 18 moved where the volume goes.**
The compose files are on `postgres:18-alpine`, and three things came with it.

The first is loud: a data directory initialised by 17 makes 18 refuse to start, so `pnpm run
up` waits on a healthcheck that will never pass. Nothing in this repository's volume is worth
keeping, so the answer here is `pnpm run db:down` (which drops it) and then `pnpm run up`,
which initialises a fresh 18 and re-applies every migration set. **That answer is wrong for a
Project holding real data**, which needs `pg_upgrade` or a dump and restore before its image
tag moves; kobai ships no tooling for it, and `kobai-upgrade` does not reach a database
(ADR-0035). Treat moving a Project's Postgres major as its own piece of work.

The second is silent, and it is why **every `db` service now mounts `/var/lib/postgresql`
rather than `/var/lib/postgresql/data`.** 18 moved `PGDATA` to a major-version-specific
subdirectory and declares its `VOLUME` at the parent, so the old path names a directory
Postgres no longer writes to. A mount left there does not fail — Docker satisfies the image's
declared volume with an **anonymous** one, the database lives in that, and `kobai-db` sits
empty looking like the database. On an existing volume the image catches this and says so; on
a fresh one nothing does, and the first `docker compose down` takes the data with it. The
compose files carry the reasoning at the mount.

A third came with it and is neither loud nor about volumes: **a Postgres major can change the
SQLSTATE a refusal arrives under.** 18 reports a key declared `on delete restrict` as
`restrict_violation` (23001) where 17 said `foreign_key_violation` (23503), and since kobai
*reads* those refusals rather than asking first, matching one code turned two ordinary 422s
into 500s. `packages/core/src/db/errors.ts` carries both codes and says why. When a Postgres
major moves, the refusals read through that module are the thing to re-check — nothing about
them fails to compile.

**`pnpm run dev` watches two things, because an edit lands in one of two places.** Every
workspace package the Project resolves at runtime does so through its `exports` to `dist` —
the same path a Developer outside this repository takes — so `scripts/dev.ts` runs
`tsc --watch` over each of them beside `node --watch` over the Project. Save a file in Core,
tsc writes `dist`, Node notices and restarts. Without both halves the loop served the build
you started it with and nothing after, which looks like your change did nothing rather than
like nothing rebuilt it.

**The Admin is deliberately in neither.** It is a browser bundle with a dev server of its
own — `pnpm run admin:dev`, in a second terminal — and rebuilding it on every keystroke here
would be slower and worse than the reload loop it already has.

**Every command lives in `package.json`, and `devbox.json` declares none** (ADR-0083). That
is asserted rather than noted: `tests/devbox-declares-no-commands.test.ts` fails the build if
a script appears there, which forbids the whole class rather than the one script that used to
be forbidden by name. The list used to live in `devbox.json` — behind a tool a contributor
had no reason to have, and baked into every Project the scaffolder generated.

**Target a package through pnpm, which knows where its packages are:**

```sh
pnpm --filter @kobai/core typecheck
```

There is deliberately **no `push` script** anywhere — not in Core, not in a Plugin, not in
the reference Project. `drizzle-kit push` diffs against the live database and silently drops
the tables of every package whose schema it was not given, leaving their tracking rows
behind so the migration runner cannot repair it. See
[ADR-0030](docs/adr/0030-generate-and-migrate-only-never-drizzle-kit-push.md). An
`tests/no-push-script.test.ts` fails the build if a push script appears in any manifest, or
in a `run:` step under `.github/workflows/`, where no script name would give it away. **The
ban is the control; nothing has to explain itself in a manifest.** Every `package.json` in
this repository used to carry a `"// …"` key beside the scripts saying why — inert to npm,
but an IDE reports each one, and thirty of them is a page of noise on a file you open to read
four commands. The reasoning belongs here and in the ADR, where prose is prose.

**`devbox.json` is HuJSON and takes real comments; a `"// …"` key there never was safe**,
because devbox turned every key into a runnable script and ate the leading slashes doing it
(#30). It declares no keys now, so the hazard is history rather than a standing rule — the
reasoning is in ADR-0083. **A `package.json` carries no such key either**, for a duller
reason: an editor flags every one of them, and a manifest is a file you open to read the
commands. `biome.json` allows the trailing-comma style `devbox add` writes,
through an `overrides` entry matching `**/devbox.json`; **run `pnpm run format` after any
`devbox add`.** The relaxation is deliberately not repo-wide: a trailing comma in a
`package.json` is a real defect, because npm requires strict JSON.

### The ports belong to the checkout, not to kobai

**In an ordinary checkout the ports are ordinary.** `compose.yaml` publishes
`${POSTGRES_PORT:-55432}` and `${PORT:-3000}`, `.env` overrides them, and that is the whole
story. 55432 rather than 5432 is deliberate and has nothing to do with any of the below: a
Developer's own Postgres should not have to move.

**A linked git worktree is the exception, and it gets a `.env` of its own** (ADR-0084). A
harness that runs work on a branch puts a whole second checkout in one, and a gitignored
`.env` does not travel into it — so sixteen worktrees would collide on 55432 until somebody
wrote a file by hand, and the failure is a container belonging to another branch, already up
and healthy on the port you wanted. So `scripts/ensure-env.ts`, chained onto `up`, `db`,
`dev`, `test` and `ci`, copies `.env.example` to `.env` with `POSTGRES_PORT` and `PORT`
filled in from a hash of the worktree's path — in the ranges **55000-55999** and
**53000-53999**, sharing their last three digits so `53154` beside `55154` reads as one
checkout in a `docker ps`. It never writes over an existing `.env`, and it does nothing at
all anywhere else.

**A worktree may therefore find `.env` already written**, which is a surprise worth
expecting. It is yours to edit from then on, and nothing rewrites it.

Four things about the arrangement are worth knowing:

- **It seeds a file rather than exporting variables, and that is the point.** The derivation
  used to live in `devbox.json`'s `init_hook` and export into each script's environment, so
  `pnpm run db` and a hand-typed `docker compose up db` in the same directory brought up two
  different stacks. Compose reads `.env` itself, so now they agree — and the values are
  legible: you read them rather than reasoning about a hash.
- **Parts, never assembled URLs.** The seed writes `POSTGRES_PORT` and `PORT` and no
  `DATABASE_URL` or `KOBAI_TEST_DATABASE_URL`. `vitest.config.ts` builds the suite's address
  from `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` and the port at run time, and
  `scripts/dev.ts` builds the host's the same way. A written-down URL goes stale the moment
  the password three lines above it changes, and the only symptom is an authentication
  failure naming neither (#63).
- **Encode against the driver, not against the RFC.** `pg` reads the user and password with
  `decodeURIComponent` and the database name with `decodeURI`, and the second never
  unescapes a reserved character — so an over-encoded `=` in a database name arrives as a
  literal `%3D` and Postgres reports a database nobody named. `scripts/env.ts` is where that
  lives, in two calls; it was thirty lines of `awk` and the finding was expensive to make.
- **A second *clone* is not a worktree.** `~/Dev/kobai` and `~/Dev/kobai-2` both take 55432
  and collide. That is knowingly given up — it is the collision every project has, and the
  answer is the one every developer knows. `COMPOSE_PROJECT_NAME` is no longer derived
  either: compose names a project after the directory's basename, and worktree basenames are
  already distinct.

An explicit value still wins, from `.env` and from the environment alike — `process.loadEnvFile`
leaves a variable already in the environment alone, which is the precedence this repository
has always had. Pin `POSTGRES_PORT` and every database address follows it; pin `PORT` and the
application serves there and the Admin's dev proxy follows; pin `DATABASE_URL` and only that
one moves.

**A derived application port has to announce itself; a derived database port does not.**
Nobody types a database port — the harness dials it and `docker ps` has it for anyone who
wants it — but a Developer opens the application in a browser. So `pnpm run up` builds,
prints where it is about to serve, and only then starts streaming logs:

```
  kobai is serving on http://localhost:53154 — health at /health, the Admin at /admin-ui
```

It is printed by `scripts/serving-on.ts` rather than by the shell, because the port may live
in `.env`, which compose reads and the shell does not — an address printed from a different
source than the one compose publishes on would be worse than no address at all.
`pnpm run dev` needs no such line: the Project logs `listening` with the port it bound, and
`pnpm run admin:dev` prints its own dev-server URL. **Inside the container the application is
still on 3000 and always will be** — a container has a network namespace to itself, so only
the host half of the mapping can collide.

What this does **not** carry is the app container's own `DATABASE_URL`: compose assembles
that one by substitution and has no way to encode anything, so a password containing `/`, `?`
or `#` breaks `pnpm run up` while the suite is unaffected. `.env.example` says so next to the
variables. Keep `$` out of a password too — compose interpolates variables inside a quoted
value, and nothing else does.

### Dependency updates

Dependencies move by **two** mechanisms, and it takes both to keep the alert list empty.
[`.github/dependabot.yml`](.github/dependabot.yml) carries the reasoning for the first in
full; the second lives in the root `package.json`. What is durable enough to belong here:

- **Weekly, on Monday** — not daily. A merged bump rewrites `pnpm-lock.yaml` and every
  open branch has to rebase onto it, so updates arrive as one predictable batch.
- **Majors are never grouped.** Minor and patch updates batch into one PR per ecosystem;
  a major matches no group and so arrives as its own PR, named for the package and the
  boundary it crosses. It is not allowed to hide inside a batch — that is the failure
  the config was written against.
- **`@types/node` is held at the major `.node-version` names.** Typing against a newer
  Node than the one that runs means typechecking against functions that do not exist at
  runtime. The pin is one of five copies of the same major, held together by
  `tests/one-node-version.test.ts`; when it moves, lift the `ignore`.
- **Security updates are the second mechanism, and no key in that file turns them on.**
  They are a repository setting, and they were already on throughout #69. What the file
  can do — shape them through the options that reach them, and batch them with a group
  carrying `applies-to: "security-updates"` — is recorded there, along with the one
  hazard worth knowing before you edit it: **an `ignore` entry suppresses a security fix
  as well as a version one**, and cannot be scoped to version updates alone.

**When Dependabot cannot fix an advisory, the lever is `overrides` in
`pnpm-workspace.yaml`.** An advisory
against a *transitive* dependency that no release of its parent moves off produces no
pull request at all — Dependabot has nothing to bump — so it sits in the alert list
indefinitely rather than arriving as work. #69 is the worked example: thirteen alerts,
three of them high, every one a transitive pin under a parent already at its latest
release. Write the override **scoped to the parent** (`parent>child`), never as a bare
package name, so it moves the one vulnerable copy and a future advisory in the same
package still surfaces as its own alert. Never write one that pins backwards — that
silences an alert instead of fixing it. Each entry carries a comment saying what it is for
and when it can go; **delete it the moment its
parent ships a release that no longer needs it**, and check that before adding a new one.

**Every pnpm setting lives in `pnpm-workspace.yaml`, not in a `pnpm` key in
`package.json`.** pnpm 11 stopped reading that key — it *warns and ignores*, so an override
left behind there goes quiet rather than red, which is the worst way for a security floor to
stop applying. The move is also what finally lets the rule above hold: a `package.json`
cannot carry a comment, and the `"// …"` keys that used to do this job were removed in
`52f42fb` because an editor flags every one of them. YAML takes real comments, so an
override's reason and its expiry sit beside it. Two other settings live there and each says
why in the file: **`allowBuilds`**, the allowlist of dependencies permitted to run install
scripts — pnpm 11 runs none by default and fails the install by name, so a new one arrives
as a decision — and a deliberately *unset* **`minimumReleaseAge`**, whose 48-hour default
must never exceed the `cooldown` in `.github/dependabot.yml`, or Dependabot proposes bumps
pnpm then refuses to install.

Taking an override rests on a reachability argument, and **an argument that a package is
unreachable expires when the code changes** — so it is written down with the day it
expires, next to the override in `pnpm-workspace.yaml` rather than only in a pull request.
#69's is the shape to copy: undici was reachable only as `openapi-typescript`'s fallback
for a `globalThis.fetch` that ADR-0031's Node 22 always provides, and kobai has no direct
`undici` use and no WebSocket use anywhere in `packages/*/src` or `reference/src`. **The
day kobai opens a WebSocket, or depends on `undici` directly, recheck that override
rather than trusting it.** The same goes for a dismissal that rests on "kobai does not
use X" — there are none open, and if one is ever taken it belongs here, with its trigger.

One thing not to trust while triaging: **the `"scope"` an alert reports.** All thirteen
of #69's said `runtime` while every one was reached only through a devDependency.

### There is no TypeScript compiler API

TypeScript 7 ships **no programmatic API**. Its `exports` map has one root entry,
`./lib/version.cjs`, declaring `version` and `versionMajorMinor` and nothing else. Code
that reached for `ts.readConfigFile`, `ts.sys` or `ts.createProgram` under 5.x has no
equivalent to move to.

So: **do not reach for the compiler to do a job a parser can do.** `vitest.config.ts` reads
`tsconfig.base.json` with `jsonc-parser`, because what it needed was JSON-with-comments,
not a compiler. That is the pattern — a `tsconfig` is a file, and reading one is parsing.

Two escape hatches exist and were both rejected in #28: `@typescript/typescript6` pins a
second, older compiler alongside the real one, and `typescript/unstable/sync` is unstable
by name and spawns the Go binary to read a single file.

**This rules out most OpenAPI client generators.** `openapi-typescript@7` and
`@hey-api/openapi-ts` both build their output as a TypeScript AST and print it with
`ts.factory`, so under TypeScript 7 they die on module load — `Cannot read properties of
undefined` — before reading a byte of input. Both bugs are filed and open upstream
(openapi-ts/openapi-typescript#2841, hey-api/hey-api#4235) and the only workaround offered is
to pin a second compiler, which is what #28 rejected. `openapi-typescript@6` emits its
TypeScript as **text** and declares no `typescript` dependency at all, so it is what
`@kobai/client` pins — exactly, with a dependabot `ignore` on the major. When 7.1 brings an
API back, that pin is a decision to revisit, not a bump to take.

TypeScript 7.1 is expected to reintroduce an API, and it will be a **different** one. Treat
anything written against the old shape as needing a rewrite rather than a version bump.

### Layout

| Path | What |
| --- | --- |
| `packages/core` | `@kobai/core` — the package a Project depends on (ADR-0025). |
| `packages/core/migrations` | Core's migration set. Generated, never hand-edited except for `--custom` files — see [Adding a required column](docs/agents/migrations.md#adding-a-required-column-to-a-table-that-already-exists) for the one case that needs both. |
| `packages/core/openapi.json` | The OpenAPI description. Generated, never hand-edited. |
| `packages/core/src/upgrade` | `kobai-upgrade` — the command that moves a Project across a kobai version, and the codemod set it consults (ADR-0035). |
| `packages/client` | `@kobai/client` — the typed client, generated from that description (ADR-0006). |
| `packages/plugin-price-log` | `@kobai/plugin-price-log` — a deliberately trivial Plugin. One table, one offered Step, one offered Subscriber, nothing else. The Step and the Subscriber are the two halves of ADR-0017's offer-and-wire rule, in one package so the difference reads side by side (#323). |
| `packages/plugin-made-to-order` | `@kobai/plugin-made-to-order` — the proof ADR-0014 asked for, at its thinnest. One Fulfilment Strategy, one offered Step that charges for a Lead Time, one table. |
| `packages/plugin-stripe` | `@kobai/plugin-stripe` — the Payment Provider Core ships none of (ADR-0053). PaymentIntents with `automatic_payment_methods`, and one table: the refunds it made for payments that produced no Order (ADR-0070). **Nothing in the gate reaches Stripe**, and it takes two things rather than one. The network is the `fetch` in `StripeOptions`, and every test that makes a call replaces it; and the reference Project takes payments at a bank only when its environment carries all three of Stripe's settings, so `vitest.config.ts` blanks those three for the whole suite — otherwise a maintainer with a live key exported in their shell would have the gate, and every Project it spawns, charge somebody. **A test that builds a provider without replacing `fetch` must not make a call with it** (`reference/src/kobai.config.test.ts` asks one its name; `reference/src/server.test.ts` boots a Project configured with a key that is not real). |
| `packages/create-kobai` | `create-kobai` — the scaffolder. Generates a Project a Developer owns (ADR-0001, ADR-0034). |
| `packages/create-kobai/template/` | What it generates. **Generated** from `reference/`, checked in, never hand-edited. |
| `packages/create-kobai/standalone/` | The few files a generated Project has and `reference/` does not. **Authored here**, not generated. |
| `packages/create-kobai/src/adaptations.ts` | The complete list of ways a generated Project differs from the reference one. |
| `reference/` | The **reference Project** — kobai's own Project and its release gate (ADR-0029). |
| `reference/kobai.config.ts` | The one file listing everything this Project has customised. |
| `reference/src/db/schema.ts` | The Project's **own** tables, in its own migration set. |
| `reference/admin/` | The **Admin**, vendored into the Project as source a Developer edits (ADR-0033). |
| `reference/Dockerfile`, `reference/compose.yaml`, `reference/package.json` | The **Project's**, generated into what a Developer receives. It ships no devbox and no toolchain of its own (ADR-0083). |
| `compose.yaml`, `Dockerfile`, `package.json` | The **workspace's** — what `pnpm run ci` and `pnpm run up` use. `devbox.json` is beside them and holds only the Node pin. |

### Where the rest of it is, and when to read it

This file holds what is true of every ticket: how to run kobai, what the gate is, where things
live, and the conventions that apply everywhere. **Everything below is true only of some
tickets, so it lives in a file of its own and is named here rather than carried by everyone.**

It used to all be here. That was one 142 kB file, and every agent working on any ticket read
all of it before writing a line — which is a fixed cost per ticket, paid mostly for sections
the ticket never touches, and it grew with every ticket that added a paragraph to it. The
split is by **what the work is**, not by what directory it happens in: a test lives beside the
code it tests, so a rule about writing tests reaches nobody if it is filed under `tests/`.

| Read | Before |
| --- | --- |
| [`docs/agents/writing-tests.md`](docs/agents/writing-tests.md) | writing a test **anywhere** — the seams, the harness, and the arrangement helpers |
| [`docs/agents/the-http-surface.md`](docs/agents/the-http-surface.md) | adding or changing a route, a refusal, a Reservation, or a Fulfilment Strategy |
| [`docs/agents/migrations.md`](docs/agents/migrations.md) | running `db:generate`, editing a `schema.ts`, or adding a column or constraint to a table that already exists |
| [`docs/agents/the-admin.md`](docs/agents/the-admin.md) | editing anything under `reference/admin/` |
| [`docs/agents/the-scaffolder-and-the-upgrade.md`](docs/agents/the-scaffolder-and-the-upgrade.md) | editing anything under `reference/` or `packages/create-kobai/`, or shipping a break a Project must be migrated across |

**Read the ones your ticket needs, in full, and none of the others.** They carry contracts you
cannot infer from the code, in the same way this file does — a skim is worth about as much
here as it would be there. If a ticket turns out to touch a surface you did not read for,
stop and read it then.

**Nothing here is a summary of them.** A rule stated in two places drifts, and the copy people
read is not always the copy people edit — so where a decision belongs to one of those files,
this one names the file and says nothing further about it. If you find yourself wanting to
restate a rule here so it is not missed, that is a sign the routing line above is not specific
enough about when the file applies; fix the line.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `y3owk1n/kobai`, managed via the `gh` CLI. See
[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

The five canonical triage roles, each label string equal to its role name. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See
[`docs/agents/domain.md`](docs/agents/domain.md).

## Agent tool scaffold

kobai is developed from many harnesses. AGENTS.md is the one place instructions live;
everything else is a pointer or a tool-specific concern that genuinely can't live in a
shared file.

| Path | Tool | Role |
| --- | --- | --- |
| `AGENTS.md` | Codex, Cursor, Zed, Amp, OpenCode, Jules, … | **Source of truth.** Read natively. |
| `CLAUDE.md` | Claude Code | Symlink → `AGENTS.md`. |
| `GEMINI.md` | Gemini CLI | Symlink → `AGENTS.md`. |
| `.github/copilot-instructions.md` | GitHub Copilot | Symlink → `../AGENTS.md`. |
| `.agents/skills/` | all | **Canonical skills directory.** One folder per skill. |
| `.claude/skills` | Claude Code | Symlink → `../.agents/skills`. |
| `.cursor/rules/` | Cursor | Cursor-only rules that don't belong in the shared file. |
| `.mcp.json` | Claude Code | Project-scoped MCP servers. |
| `.codex/config.toml` | Codex | The same MCP servers, in Codex's format. |
| `docs/agents/` | all | Machine-facing config the engineering skills read, **and the surface-specific half of this file** — see [Where the rest of it is](#where-the-rest-of-it-is-and-when-to-read-it). |

**Rule: never add instructions to a tool-specific file that would apply to every tool.**
Put them in AGENTS.md. `.cursor/rules/` earns its place only for things that are true of
Cursor and false elsewhere (its cloud VM, for instance). If you add an MCP server, add it
to **both** `.mcp.json` and `.codex/config.toml` — they are hand-kept in sync.

### Repo-local skills

Skills shared by every harness live in `.agents/skills/<name>/SKILL.md`, with YAML
frontmatter carrying `name` and a `description` that says **when** to reach for it. To
expose one to Codex, add `.agents/skills/<name>/agents/openai.yaml`:

```yaml
interface:
  display_name: "Human readable name"
  short_description: "One line."
  default_prompt: "Use $skill-name to ..."
```

## Conventions

- **Line endings** are LF everywhere (`.gitattributes` enforces `eol=lf`); Windows
  contributors should not let autocrlf rewrite them.
- **Secrets** never enter the repo. `.env` is gitignored; every variable kobai reads is
  documented in `.env.example`, and a new one goes there in the same commit.
- **Don't create `CONTEXT.md` or `docs/adr/` upfront.** `/domain-modeling` writes them
  lazily, when a term or decision is actually resolved. Their absence is not a problem to
  fix.
