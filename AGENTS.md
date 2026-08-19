# kobai

Open source e-commerce backend plus CMS.

> **Status: walking skeleton in progress.** The stack is chosen and the first slice boots —
> see [Development](#development). Everything not yet built is still undecided: do not infer
> conventions that aren't written down here, and do not invent them. If you need a decision
> that isn't recorded, that's a signal to go resolve it (see
> [Working on kobai](#working-on-kobai)) rather than to guess.

This file is the **single source of truth** for agent instructions. Every other agent
config in this repo points back here — see [Agent tool scaffold](#agent-tool-scaffold).
When you learn something durable about how kobai should be built, it belongs here, in
`CONTEXT.md`, or in an ADR under `docs/adr/` — not in a tool-specific file.

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

**Prerequisites: [devbox](https://www.jetify.com/devbox) and Docker. Nothing else.** Node and
pnpm are not expected on your PATH — devbox provides them, and corepack activates the pnpm
pinned in `package.json`. Run every Node command through `devbox run …` or from inside
`devbox shell`.

**The gate is `devbox run ci`.** It is the single command that proves the repository is
green: install, Postgres up, lint, typecheck, build, test. Nothing is done until it passes,
and no PR opens on a red one.

**The gate fails on every finding Biome reports, at any severity** (ADR-0039). `biome ci`
exits *zero* on warnings by default, and Biome 2 re-tiered most of what Biome 1 called an
error down to `warn` or `info` — so `devbox run lint` and the gate both pass
`--error-on-warnings`, and `biome.json` lifts the 28 recommended rules that default to `info`
up to `warn`, which no flag can do. **`devbox run lint` and the lint step of `devbox run ci`
run the identical biome invocation**, deliberately: a gate stricter than the command you are
told to run is a difference that shows up nowhere until CI goes red. The `lint` script opens
with the fresh-checkout guard below and `ci` does not, because `ci` installs first; that
prefix is what the identity assertion strips, and it strips nothing else. `devbox run format`
is the
forgiving one — it rewrites rather than reports, so it is where a finding gets fixed. Reach
for it first; most findings below `error` carry a safe fix.

Three things follow, and each has a test rather than a convention behind it:

- **A rule below the floor is a decision.** `tests/the-lint-gate-fails-below-error.test.ts`
  asks Biome for every rule's default severity *at gate time* and fails naming any enabled
  rule that resolves below `warn`. So a Biome upgrade that demotes a rule, or adds a
  recommended one at `info`, turns the build red instead of quietly widening what passes —
  which is exactly how the gate got loose in the first place (#28, #45). Answer it by
  promoting the rule to `"warn"` under its group in `biome.json`, or by turning it `"off"`
  on purpose. Do not delete the assertion.
- **`biome.json` cannot explain itself.** A comment in it stops Biome parsing its own config:
  it walks *up* to the parent checkout's and fails with "found a nested root configuration",
  naming a directory you are not in. Every explanation lives in ADR-0039 or ADR-0033
  instead. `devbox.json` is the opposite — HuJSON, real comments welcome, `"// …"` keys
  never (ADR-0030).
- **`devbox add` rewrites `devbox.json` into trailing-comma style.** `biome.json` expects
  that, through an `overrides` entry matching `**/devbox.json` — the workspace's and the
  reference Project's alike — so the result is an ordinary formatting difference
  `devbox run format` repairs. Without the override it was a *parse* error, and `format`
  cannot repair a file it cannot parse. The relaxation is deliberately not repo-wide: a
  trailing comma in a `package.json` is a real defect, because npm requires strict JSON.
  **Run `devbox run format` after any `devbox add`.**

| Command | What it does |
| --- | --- |
| `devbox run install` | `pnpm install --frozen-lockfile`. **The first command in a checkout that has never installed** — every command below that runs a binary out of `node_modules` refuses until it has, and says so. |
| `devbox run ci` | **The gate.** Everything below, in order — it installs first, so it needs nothing run before it. |
| `devbox run up` | Postgres and the reference Project, on this checkout's own port — it prints the URL. `/health`, Admin at `/admin-ui`. |
| `devbox run down` | Stop them. `devbox run db:down` also drops the volume. |
| `devbox run admin:dev` | The Admin with a reload loop, beside `devbox run dev`. See [The Admin](#the-admin). |
| `devbox run db` | Just Postgres — what the test suite needs, on this checkout's own port. |
| `devbox run browsers` | Downloads the Chromium the Admin's browser seam drives. `ci` and `test` run it themselves. |
| `devbox run test` | Postgres up, build, then the whole suite. |
| `devbox run typecheck` / `lint` / `format` / `build` | One step each. |
| `devbox run db:generate` | Build, then generate a migration in every package whose schema changed — Core and each Plugin. |
| `devbox run openapi:generate` | Regenerate the OpenAPI description, then the client generated from it. |
| `devbox run template:generate` | Regenerate what `create-kobai` generates, from the reference Project. |

**A checkout that has never installed is an ordinary state, and every command says so rather
than working around it.** A fresh clone, a `git worktree add`, an agent's worktree: in all of
them `node_modules` is absent, and `devbox run lint` and `devbox run format` used to fail there
with `Command "biome" not found` — a message naming a binary, leaving the reader to work out
that a package manager never ran, on the command this file tells you to reach for *first*
(#133). So every script in **every** `devbox.json` in this repository that runs a binary out
of `node_modules` opens with **`sh scripts/require-install.sh <its own name> &&`**, and the
refusal names the command that could not run and what to run instead of it. `install` and
`ci` carry no guard, because they *are* the install; nor do the docker-only scripts, which
need nothing installed at all.

It is a guard rather than an install in front of each script, deliberately. Prefixing
`pnpm install --frozen-lockfile` would make the fast commands pay for an install every time —
and would make them **refuse whenever the lockfile is stale**, so `devbox run format`, the
command you reach for to fix a finding, would stop working exactly while a dependency change
is in flight. The guard costs a stat and can introduce no failure a working checkout does not
already have. It answers "nothing has installed here", never "what is installed is current":
a stale `node_modules` is what the gate's own `--frozen-lockfile` is for.

**It is a file rather than a shell function in the `init_hook`, and that part is not a
preference.** devbox generates one script per key and has it source the hook *only when a
devbox shell is not already active* — the generated script guards `. .hooks.sh` on
`__DEVBOX_SKIP_INIT_HOOK_<hash>`. An exported **variable** survives into that child shell,
which is why the port derivation in the same hook never showed this; a shell **function** does
not, so a guard defined there was missing from every script run the second way this section
documents, and `devbox run lint` inside `devbox shell` died at 127 naming an internal
function. **The hook may export variables a script reads; a script may call none of its
functions.** `tests/a-fresh-checkout-is-told-what-to-run.test.ts` holds that, holds the
message against a checkout with no `node_modules`, and derives from each `devbox.json` itself
the list of scripts needing the guard — so **a new script that runs `pnpm` needs the guard,
passing its own name**, and the sweep names it if it does not.

**A Project ships a guard of its own, and there are deliberately two of them** (#139). A
generated Project is the fresh-checkout case *by definition* — it is the only state it has
ever been in — and its Developer has neither this repository in front of them nor
`devbox run ci` in muscle memory, so `devbox run dev` failing with `Command "vite" not found`
was the worse half of the same bug. `reference/scripts/require-install.sh` is that second
copy: generated into `packages/create-kobai/template/` like everything else under
`reference/`, packed into the tarball a Developer installs, and named by the same prefix in
front of every script in the Project's `devbox.json` that runs pnpm. **It needed no entry in
`adaptations.ts`** — the file is the same in both trees, which is what anything genuinely
shared between them should be.

**The two copies do the same thing and say different things, and it is the doing that is held
identical.** kobai's refusal points at `devbox run ci` and at this section; a Project has
neither, and has `devbox run up`, which installs nothing locally because the install happens
inside the image. One message forced on both would have made one of them false, which is the
failure the guard exists to remove. So each copy carries its words in exactly two shell
variables, `fix` and `note`, and
`tests/a-fresh-checkout-is-told-what-to-run.test.ts` compares every line of the two files that
is neither one of those two nor a comment, and fails naming the one that differs. **What is
held identical is the check, not the file**: each copy's header explains itself to its own
reader, and a Developer's Project has no reason to be told about #133. A fix applied to one copy and not the other —
the drift this ticket weighed against copying at all — is now a red build rather than an
invisible difference, and that comparison has been watched failing against a copy whose check
was changed alone. The same file runs all **three** copies (the third is the template's, which
is what a Developer actually receives) against a directory with and without `node_modules`,
and sweeps all three `devbox.json`s for the scripts that need the prefix.

Four shapes were rejected, each for a reason worth keeping:

- **Inline the check in each of the Project's scripts.** No second file, but six copies of a
  one-liner inside JSON strings, and the reasoning that justifies it would live only in the
  workspace's copy.
- **Say it in the Project's README instead.** A README is read before the first command or
  not at all, and this failure arrives during it.
- **Have `create-kobai` run the install itself.** It changes what the scaffolder promises,
  and it does nothing for the second clone of that Project — a colleague's checkout is the
  same fresh state again.
- **Move the two sentences into `devbox.json`'s `env` block**, so the guards could be
  compared byte for byte. That buys a stricter comparison of the half nobody doubted by
  moving the words a reader sees one indirection away from the file that prints them — and
  the guard would then degrade silently, printing a message with its advice missing, whenever
  it is run any way other than through devbox.

**`devbox run -- <cmd>` runs from the project root and ignores a preceding `cd`.** So this:

```sh
cd packages/core && devbox run -- tsc -p tsconfig.json   # typechecks the ROOT project
```

silently checks the wrong thing and passes. It is a bad failure because it looks like
success. Target a package through pnpm instead, which knows where its packages are:

```sh
devbox run -- pnpm --filter @kobai/core typecheck
```

There is deliberately **no `push` script** anywhere — not in Core, not in a Plugin, not in
the reference Project. `drizzle-kit push` diffs against the live database and silently drops
the tables of every package whose schema it was not given, leaving their tracking rows
behind so the migration runner cannot repair it. See
[ADR-0030](docs/adr/0030-generate-and-migrate-only-never-drizzle-kit-push.md). An
explanation sits where the command would have been — a **real comment** in `devbox.json`, a
`"// …"` **key** in each package's `package.json` — and `tests/no-push-script.test.ts` fails
the build if a push script appears in either, or in a `run:` step under
`.github/workflows/`, where no script name would give it away.

### The ports belong to the checkout, not to kobai

**`devbox run db` publishes Postgres on a port derived from this checkout's path**, in the
range **55000-55999** — so `docker ps` will show something like `55154`, not the `55432` the
files fall back to. **`devbox run up` publishes the application the same way**, in
**53000-53999**, from the same number and so with the same last three digits: `53154` beside
`55154` is one checkout, not two unrelated stacks. Read both ranges as the port the service
is known by with a `5` in front of it.

That is not a mystery, it is the point: two checkouts of kobai (a second clone, a git
worktree) differ by their path and nothing else, so hashing the path gives each one ports of
its own — and lets one run `devbox run ci` while another serves `devbox run up`, with
nothing passed by hand. A *random* port would do that too and would be worse: a path does
not change between runs, so the container yesterday's run left behind is still findable at
today's port.

The derivation lives in `devbox.json`'s `init_hook`, in front of every script, and it sets
five things from the one number:

| Variable | What it decides |
| --- | --- |
| `POSTGRES_PORT` | The host port `compose.yaml` publishes the `db` service on. |
| `PORT` | The host port it publishes the `app` service on; the port `devbox run dev` binds; and the address `devbox run admin:dev` proxies to. |
| `KOBAI_TEST_DATABASE_URL` | The address the test harness dials (`packages/core/src/testing/database.ts`). |
| `DATABASE_URL` | Where `devbox run dev` reaches that container from the host. |
| `COMPOSE_PROJECT_NAME` | `kobai-<hash>` — which containers and which volume this checkout owns. |

**One source decides all five, and that is the property worth keeping.** They used to
default independently, so the port had to be passed twice and kept in step by whoever
remembered; forgetting one brought the container up on one port while the suite dialled
another, and neither error named the other (#21).

**The credentials travel the same way, and the two addresses are percent-encoded** (#63,
[ADR-0046](docs/adr/0046-the-postgres-credentials-belong-to-dot-env-too.md)). The hook reads
`POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` out of `.env` with the same helper
that reads the port, and builds both database addresses from them — so a password changed in
the one file compose reads is the password the suite signs in with. It did not used to be:
the harness was handed `kobai:kobai` whatever `.env` said, and the only symptom was an
authentication failure naming neither file. Three things about it are easy to get wrong:

- **`kobai_dotenv` is the reader, and there is one of it** — the `DATABASE_URL` line asks
  through it too. It follows docker compose's own env-file grammar: a leading `export` is
  stripped, `\n`/`\r`/`\t`/`\"`/`\\` are interpreted inside double quotes, single quotes are
  raw, a bare value loses leading blanks and ends at a ` #`. Each clause was checked against
  `docker compose config` reading the same file, which is how the first two were found at
  all. The one piece deliberately *not* copied is compose's `${VAR}` interpolation inside a
  value, so keep `$` out of a password. A second parser would be two answers to what `.env`
  says.
- **`kobai_urlencode` takes which half of the URL it is filling.** `pg` reads the user and
  password with `decodeURIComponent` and the database name with `decodeURI`, and the second
  never unescapes a reserved character — so an over-encoded `=` in a database name arrives
  as a literal `%3D`. Encode against the driver, not against the RFC. It walks bytes rather
  than lines, because a value can hold a newline and awk's record separator would eat it.
- **The hook is sourced under `set -e`.** A line of it that returns non-zero takes down every
  `devbox run …` with a bare exit status and no message. A checkout with no `.env` is the
  ordinary case, so reading one that is not there must not be a failure — and
  `tests/support/init-hook.ts` runs the hook with `set -e` for that reason.

What this does **not** carry is the app container's own `DATABASE_URL`: compose assembles that
one by substitution and has no way to encode anything, so a password containing `/`, `?` or
`#` breaks `devbox run up` while the suite is unaffected. `.env.example` says so next to the
variables.

The project name is set for the same reason. Compose otherwise names a project after the
checkout directory's basename, so two checkouts both called `kobai` would share a project,
and therefore a volume, and therefore a database — a far quieter failure than a port
collision. Carrying the whole hash rather than a port keeps that true even for two checkouts
that happen to derive the same pair: they stay separate projects and collide loudly on the
ports, which is the failure you want.

**A derived application port has to announce itself; a derived database port does not.**
Nobody types a database port — the harness dials it and `docker ps` has it for anyone who
wants it — but a Developer opens the application in a browser, and 3000 was the one thing
about `devbox run up` you never had to look up. So `devbox run up` builds, prints where it
is about to serve, and only then starts streaming logs:

```
  kobai is serving on http://localhost:53154 — health at /health, the Admin at /admin-ui
```

`devbox run dev` needs no such line: the Project logs `listening` with the port it bound, and
`devbox run admin:dev` prints its own dev-server URL. **Inside the container the application
is still on 3000 and always will be** — a container has a network namespace to itself, so
only the host half of the mapping can collide — and 3000 remains what every file falls back
to for a bare `docker compose` outside devbox (#61).

**An explicit value still wins**, and from `.env` as well as from the environment, because
`.env` is where `.env.example` sends a Developer and docker compose reads it too — a pin
compose honoured while the harness ignored it would be this same bug in a new place. Pin
`POSTGRES_PORT` and every database address above follows it; pin `PORT` and the application
serves there and the Admin's dev proxy follows; pin `DATABASE_URL` and only that one moves.
So CI can fix a port, and so can anyone who wants one they can type. The 5432 a Developer's
own Postgres sits on is untouched either way.

### Never use a `"// …"` key in `devbox.json`

**devbox turns every key into a runnable script and eats the leading `//` doing it.** It
writes `.devbox/gen/scripts/<key>.sh` through a path join, and a join collapses `//`, so
`"//db:generate"` lands on the *real* `db:generate` script's file and whichever is written
last wins — and `"//db:push"` creates the very `devbox run db:push` ADR-0030 says must never
exist. It self-heals whenever another script regenerates the file, which is why one passing
run proves nothing. Observed on devbox 0.17.5; #30 has the reproduction.

`devbox.json` is **HuJSON**, so write a real `//` comment instead — it can never become a
command, and `biome.json` already sets `json.parser.allowComments`. The `"// …"` *key* stays
correct in a `package.json`: npm requires strict JSON, so a comment cannot go there, and npm
attaches no meaning to the key, which leaves it inert. `tests/no-push-script.test.ts` knows
the difference — it reads `devbox.json`'s comments rather than its keys, judges a `"// …"`
key there as the command devbox would generate from it, and fails if any key in the file
would generate over another one.

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
- **`@types/node` is held at the major `devbox.json` provides.** Typing against a newer
  Node than the one that runs means typechecking against functions that do not exist at
  runtime. The Node pin is recorded in ADR-0031; when it moves, lift the `ignore`.
- **Security updates are the second mechanism, and no key in that file turns them on.**
  They are a repository setting, and they were already on throughout #69. What the file
  can do — shape them through the options that reach them, and batch them with a group
  carrying `applies-to: "security-updates"` — is recorded there, along with the one
  hazard worth knowing before you edit it: **an `ignore` entry suppresses a security fix
  as well as a version one**, and cannot be scoped to version updates alone.

**When Dependabot cannot fix an advisory, the lever is `pnpm.overrides`.** An advisory
against a *transitive* dependency that no release of its parent moves off produces no
pull request at all — Dependabot has nothing to bump — so it sits in the alert list
indefinitely rather than arriving as work. #69 is the worked example: thirteen alerts,
three of them high, every one a transitive pin under a parent already at its latest
release. Write the override **scoped to the parent** (`parent>child`), never as a bare
package name, so it moves the one vulnerable copy and a future advisory in the same
package still surfaces as its own alert. Never write one that pins backwards — that
silences an alert instead of fixing it. Each entry carries a `"// pnpm.overrides.…"` key
in `package.json` saying what it is for and when it can go; **delete it the moment its
parent ships a release that no longer needs it**, and check that before adding a new one.

Taking an override rests on a reachability argument, and **an argument that a package is
unreachable expires when the code changes** — so it is written down with the day it
expires, next to the override in `package.json` rather than only in a pull request.
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
| `packages/core/migrations` | Core's migration set. Generated, never hand-edited except for `--custom` files — see [Adding a required column](#adding-a-required-column-to-a-table-that-already-exists) for the one case that needs both. |
| `packages/core/openapi.json` | The OpenAPI description. Generated, never hand-edited. |
| `packages/core/src/upgrade` | `kobai-upgrade` — the command that moves a Project across a kobai version, and the codemod set it consults (ADR-0035). |
| `packages/client` | `@kobai/client` — the typed client, generated from that description (ADR-0006). |
| `packages/plugin-price-log` | `@kobai/plugin-price-log` — a deliberately trivial Plugin. One table, one offered Step, nothing else. |
| `packages/plugin-made-to-order` | `@kobai/plugin-made-to-order` — the proof ADR-0014 asked for, at its thinnest. One Fulfilment Strategy, one offered Step that charges for a Lead Time, one table. |
| `packages/create-kobai` | `create-kobai` — the scaffolder. Generates a Project a Developer owns (ADR-0001, ADR-0034). |
| `packages/create-kobai/template/` | What it generates. **Generated** from `reference/`, checked in, never hand-edited. |
| `packages/create-kobai/standalone/` | The few files a generated Project has and `reference/` does not. **Authored here**, not generated. |
| `packages/create-kobai/src/adaptations.ts` | The complete list of ways a generated Project differs from the reference one. |
| `reference/` | The **reference Project** — kobai's own Project and its release gate (ADR-0029). |
| `reference/kobai.config.ts` | The one file listing everything this Project has customised. |
| `reference/src/db/schema.ts` | The Project's **own** tables, in its own migration set. |
| `reference/admin/` | The **Admin**, vendored into the Project as source a Developer edits (ADR-0033). |
| `reference/Dockerfile`, `reference/compose.yaml`, `reference/devbox.json`, `reference/scripts/` | The **Project's**, generated into what a Developer receives. |
| `compose.yaml`, `Dockerfile`, `devbox.json` | The **workspace's** — what `devbox run ci` and `devbox run up` use. |

### `updated_at` is a trigger, and a new Core table needs one

**Every Core table carrying `updated_at` has a `before update` trigger calling
`core_set_updated_at()`, and none of that is in `schema.ts`** (ADR-0037). Drizzle's
`$onUpdate` was rejected: it fires only for writes going through Core's own query builder,
and under ADR-0004 the writers Core does not mediate — a Project, a Plugin, a hand-run
`UPDATE`, a raw `db.execute` inside Core — are the normal case rather than the
exception. Core's whole HTTP surface performs **two** `UPDATE`s today — one from a handler,
and one on the authentication path, where a request slides its session's deadline (ADR-0045)
— so a mechanism covering only Core's writes would cover almost nothing. The column had
defaulted to `now()` and never moved since the first table shipped, which is why the bar here
is a value that moves rather than a schema that looks right (#32).

So **adding a Core table with `updated_at` is two steps, not one**: the column in
`packages/core/src/db/schema.ts`, then a `--custom` migration attaching the trigger, the way
`packages/core/migrations/0009_updated_at_triggers.sql` does. `drizzle-kit` has no trigger in
its schema model, so `generate` will neither write that for you nor notice it is missing —
and a later migration that drops and recreates a table takes the trigger with it, silently.
`packages/core/src/db/updated-at.test.ts` is the guardrail: it asks Postgres for every
`core_` table carrying the column and fails naming any without a trigger.

**A Plugin's tables are the Plugin's business.** Core attaches nothing to them and a Plugin
that wants the same guarantee writes its own function and trigger in its own migration set —
never by calling `core_set_updated_at()`, which is a detail of a schema Core promises nothing
about. `@kobai/plugin-price-log` carries `resolved_at` and no `updated_at` at all, because
its rows are never updated.

### Adding a required column to a table that already exists

**Never ship `ALTER TABLE … ADD COLUMN … NOT NULL` with no default.** Postgres refuses it
against a table holding one row, and that is the *one* statement `drizzle-kit generate`
writes from a new `.notNull()` field on an existing table — so the hazard arrives by itself,
from an ordinary declaration, and nothing here notices. Every test database is created
seconds before it is migrated, so the statement is green in this repository and red at the
first Project with traffic; under ADR-0030 the set runs against a live database at boot, so
that Project gets no service rather than a bad column.

The shape is **three migrations, and only the middle one is written by hand** (ADR-0038).
`packages/plugin-price-log/migrations/0001`–`0003` is the worked example:

1. **Generated** — write the field *without* `.notNull()` and `devbox run db:generate`. A
   nullable column is safe to add at any size.
2. **Hand-written**, via `drizzle-kit generate --custom`: the backfill, an `UPDATE` giving
   every existing row a value.
3. **Generated** — put `.notNull()` back and generate again, which emits `ALTER COLUMN …
   SET NOT NULL`.

**This does not bend "generated, never hand-edited".** Both schema steps *are* generated,
from `schema.ts`, with their snapshots and journal entries; the hand-written one carries no
schema change at all. drizzle-kit diffs schemas, so a data change is invisible to it in both
directions — it will neither write a backfill nor notice one is missing — which is the same
reason Core's seed migrations and `0009_updated_at_triggers.sql` are hand-written. Do not
reach for `--custom` to make a *schema* change by hand: its snapshot is a copy of the
previous one, so drizzle-kit would believe the change never happened and generate it again.

**`ADD COLUMN … NOT NULL DEFAULT v` is the right answer when the value is right for future
rows too** — it is one statement and, on Postgres 11 and later, needs no table rewrite. Then
the default belongs in `schema.ts` as an ordinary `.default()`, where it is visible. A
default that has to be dropped once it has done its job was never a default; it was a
backfill. And **a backfill value has to say the fact was never recorded, not guess at it** —
`price_log_entry` uses ISO 4217's `XXX`, the code for "no currency involved", precisely
because no real currency code could be told apart from one the Plugin had actually observed.
If no such value exists, that is a finding about the column, not something to solve in SQL.

**A unique index is the same hazard through a different statement, and the same shape answers
it** (#119). Postgres refuses `CREATE UNIQUE INDEX` against a table already holding two rows
that agree on the indexed columns, and `drizzle-kit generate` writes exactly that from a
`uniqueIndex()` added to a table that already exists — unprompted, from an ordinary
declaration, like the column. So: **deduplicate in a `--custom` migration first, then generate
the index**, so the constraint arrives onto data that can satisfy it. The middle step is
hand-written for the same reason a backfill is — an `UPDATE` or a `DELETE` is a data change
drizzle-kit will neither write nor notice is missing — and it has to be defensible in the same
way: keeping the newest of a set of duplicates is right only if the others are genuinely the
same fact, and where they are not, that is a finding about the constraint rather than
something to solve in SQL. A **plain** `CREATE INDEX` is not this: no row can refuse one, its
cost on a populated table is a lock, and the remedy for that is `CONCURRENTLY`, which cannot
run inside the transaction a migration is applied in.

**Uniqueness arrives in two spellings and the check reads both** (#153). `ALTER TABLE … ADD
CONSTRAINT … UNIQUE` is what a `.unique()` on a column generates — eight of those in
`packages/core/src/db/schema.ts` against three `uniqueIndex()`, so it is the *likelier* way a
future uniqueness requirement arrives — and it rests on the same one excuse: the table was
created in this migration, or it was not.

**`ALTER TABLE … ADD CONSTRAINT … CHECK` is deliberately not read, and the shape above is
still what answers it.** Postgres refuses one against a row that does not satisfy it, so the
hazard is as real as the others; what is missing is any way to tell from the text whether the
rows do. `packages/core/migrations/0027` adds one and is safe, and what makes it safe is the
statement immediately before it, which adds `tax` with `DEFAULT 0` and so answers the
predicate for every row already there — telling that from the same pair with a default the
check would refuse means *evaluating* the predicate, which is a SQL engine rather than a
reading. Reading earlier migrations would not rescue it either: the backfill belongs in a
`--custom` migration of its own, so the generated migration that adds a constraint holds the
constraint and nothing else, and a check that flagged it would be red for the correct shape as
well as for the broken one — the same reason `ALTER COLUMN … SET NOT NULL` is left unread. So
**a `CHECK` arriving at a table with rows in it is yours to put a backfill in front of**;
nothing here will tell you that you forgot.

Two tests hold this. `packages/plugin-price-log/src/migrations.test.ts` seeds a row and then
applies the rest of the set — the only place in this repository a migration meets data —
using `migrationSetUpTo` from `@kobai/core/testing`.
`tests/migrations-are-safe-against-populated-tables.test.ts` reads every migration in the
repository for the statements themselves: a required column with no default, and uniqueness —
as an index or as a constraint — arriving at a table the same migration did not create. Those
last two have only the one excuse a reading of a single file can make — **the table was
created here, so no row it has not seen can refuse anything** — which is the same excuse
Core's foreign keys already rest on.
Core's own set is otherwise clear and stays clear that way: every `NOT NULL` in it is inside a
`CREATE TABLE`, and its only `ALTER TABLE`s add foreign keys to tables created in the same
migration.

**`0016`'s unique index on `core_order.cart_id` is named by that check and shipped anyway**: a
deployment left anywhere between `0012` — where `core_order` is created — and `0015` could meet
it with the very duplicates `0016` exists to prevent, since until then a Cart could become two
Orders. **That one is a release decision and it lives in
[ADR-0061](docs/adr/0061-what-the-first-publish-owes.md)**, the one list of what the first
publish owes, under the heading naming `0016` — with why the deduplication was not written, the
one question to ask before the first publish, and both answers to it. Do not re-take it here or
in the test; the test's entry points at it. What belongs in this file is the mechanism: the
acknowledgement is an equality rather than an ignore list, so a statement it names that changes fails it and one it does not
name that appears fails it too, and answering a finding there is a decision written down, never a
line added to a list.

**An acknowledgement says which of two judgements it is, because the correct shape produces the
identical finding** (#161). The reading is per-file and has to be — ADR-0038 puts the
deduplication in a `--custom` migration of its own — so "safe, because the migration before it
deduplicated" and "unsafe, but unreachable while nothing is published" arrive as the same text,
and a list that told them apart in prose alone would be one list of two meanings. So each entry
carries a **kind**, and each kind carries the one thing that would show it false: a
`deduplicated-ahead-of-it` entry names the migration that removed the duplicates, which has to
run ahead of it in the same set; an `unreachable-until-release` entry names the record arguing it
**and the section of that record which lists what falls due**, which has to name the migration
back — so ADR-0061's entry for `0016` cannot be shorter than the constant, and emptying or
renaming it fails rather than quietly emptying the list. **Both checks are
assertions, not conventions**, and a kind added without a warrant does not compile. What neither
check reads is the argument itself — that the migration named really did remove the right
duplicates, that the record's prose is still true — because reading it would be checking wording.
That stays the author's to argue in prose beside the entry, which is where the reasoning still
lives.

### Scarcity is claimed in one statement, and the sweeper is a plain interval

**A claim on something scarce is a conditional write, never a read followed by a write**
(ADR-0018). `packages/core/src/reservation/inventory.ts` holds stock with a single
`update … set reserved = reserved + n where on_hand - reserved >= n`, so Postgres takes the row
lock before it evaluates the condition and the loser of a race re-evaluates against the row the
winner left. A `select` and then an `update` cannot do this and no amount of care makes it — the
Store oversells and has merely implemented the appearance of safety, which is worse than none.
The same shape is already how a Cart keeps one line per Variant and how a Cart becomes exactly
one Order; those are unique indexes rather than conditional updates, and both are the ADR's
"a row lock or a unique constraint".

No sequential assertion can see any of this, so **the guardrail is a concurrent test** —
`packages/core/src/reservation/the-last-unit.test.ts`, dispatching many `POST /store/orders` at
one unit of stock. **There are two of them**, and the second is
`packages/core/src/reservation/the-variant-that-vanished.test.ts` — the same shape on the path
where no money is involved (#145), dispatching six
`DELETE /admin/variants/{id}` and six `PUT …/inventory` together after the count path was found
reading a Variant in one statement and writing against it in another. How one of those is
written, why each of its assertions is there, and why a green run proves less than you would
think, is in [Writing tests](#writing-tests) with the other seams; **write the next one the same
way round.**

**One interface, and the providers are Core's own.** `reservation/provider.ts` is ADR-0018's
single Reservation interface; Inventory is its only implementation and Capacity joins
`RESERVATION_PROVIDERS` when it is built. `core_reservation` is Core's record for every provider
alike — `provider` and `subject`, so a Capacity claim needs no column and no table of its own —
and only the provider knows what a subject means. Nothing on the promised surface hands a Project
a way to supply one; that would be a config key and an ADR, and neither exists.

**Consuming happens inside the Capture transaction, and releasing is guarded by the row.** That
is why `hold-reservations` sits before `take-payment` and why `capture-order` declares no
compensation: the database unwinds a claim and an Order together. A release — from the Step's
compensation or from the sweeper — is an
`update core_reservation set released_at = now() where … released_at is null … returning`, and
the rows it actually claims are the only ones whose units go back, so the two can race and the
units are returned exactly once.

**The sweeper is a plain interval and deliberately not ADR-0026's job queue** (ADR-0057) — a
queue brings retry, visibility and failure semantics that deserve their own spec, and the queue
spec will have to migrate this (#98). `packages/core/src/sweep.ts` releases lapsed holds and deletes expired
`core_idempotency_key` rows in the same pass; a Project starts it with `kobai.startSweeper()`
**after** `migrate()`, exactly as it seeds its first Merchant, and `kobai.close()` stops it.
**Test it by winding rows back and calling `kobai.sweep()`** — never by waiting for a
fifteen-minute hold — the way `packages/core/src/sweep.test.ts` does; the one test that waits is
the one whose subject is the timer itself.

### A Variant points at a Fulfilment Strategy, and never carries a flag

**`requires_shipping` and `tracks_inventory` are questions a Strategy answers, never columns on
a Variant** (ADR-0014). `core_variant.fulfilment_strategy` holds a **name** — `physical`,
`digital`, or whatever a Project wired a Plugin's under — and `packages/core/src/fulfilment/`
holds the interface Core asks. A `check` constraining that column, or an enum in `contract.ts`
listing Core's two, would be the closed set the ADR exists to rule out, in the place it is
hardest to remove.

**It is dependency substitution, not a sixth Extension Point** (ADR-0052). A Plugin *offers* a
Strategy and the Project wires it as `fulfilment: { strategies: { "made-to-order": … } }`, keyed
by the name its Variants point at — so a Strategy has no `name` of its own, exactly as a replaced
Workflow Step is named by the slot it fills. **The key is the name, and there is one of it.**
Building this as anything a Plugin can register into is how the list of five quietly becomes six.

Four things follow, and each is a decision rather than an implementation detail:

- **A Variant may only point at a Strategy the deployment has wired.** `POST /admin/products`
  and `PATCH /admin/variants/{id}` both refuse `unknown-fulfilment-strategy` at 422, naming the
  ones it does have; `place-order` refuses the same reason at 409, which is only reachable by
  *unwiring* a Strategy Variants already point at. Guessing `physical` for an unknown name would
  claim stock nobody asked to claim and record an Order as shipping something that does not ship.
- **A Variant's Strategy is swappable, and the stock count under it never moves** (ADR-0062).
  `PATCH /admin/variants/{id}` is how a poster becomes a download and how a Variant left pointing
  at an unwired Strategy is repaired — the state `place-order`'s 409 exists for, which until #144
  could only be mended by deleting the Product. **Do not make a swap delete the `core_inventory`
  row**: it discards a count a Merchant took, and `consume` is guarded, so it would fail a
  Capture past `take-payment` and refund a Shopper — ADR-0059's argument, reached through an
  update. That is also why no update is refused for a live hold: an update takes nothing away.
- **The answers are asked once per placement and carried.** `load-cart` resolves each line's
  `AppliedFulfilment`; `hold-reservations` reads `tracksInventory` off it and `capture-order`
  snapshots it. A Step that asked again could get a different answer, because a Strategy is asked
  *about a Variant* and may read its `metadata` (ADR-0013).
- **Not tracking Inventory means no claim, not a claim of zero.** The filter lives in
  `inventoryProvider.claimsFor` rather than in the Step, because deciding *which* lines are its
  business is what a provider is for — Capacity will read `hasLeadTime` there in the same place.
  A digital Variant therefore needs no Inventory row, and sells freely even if somebody counted
  it: the Strategy says whether stock is involved and the row only says how many.
- **The wired set is readable, and that is a route rather than a constant** (ADR-0067, #179).
  `GET /admin/fulfilment-strategies` answers every name a Variant may point at — Core's two and
  whatever the Project wired beside them — built from `fulfilmentStrategyNames`, the same helper
  the `unknown-fulfilment-strategy` refusals list the known names with, so the answer and the
  refusal cannot drift. It exists because a client offering a choice had no other honest source:
  hard-coding `physical` and `digital` is the closed set ADR-0014 exists to rule out, moved into
  every client and wrong on the first deployment that wires a Plugin's. **It answers a name and
  nothing else** — the three questions are asked *of a Variant*, so there is no answer to carry
  without one — and it deliberately **does not page**, which is the one departure from ADR-0064
  on the whole surface.

**Fulfilment is its own entity** — `core_fulfilment`, one row per way an Order is delivered,
with `core_order_line_item.fulfilment_id` pointing at it — because one Order has many on
independent timelines and a status column would force one lifecycle onto all of them. The three
answers are **copied onto the row** at Capture (ADR-0009): rewiring a Strategy, or removing the
Plugin that offered one, must not rewrite an Order. Fulfilling anything is a later spec; what
exists is the shape.

**The Strategy from outside Core is `@kobai/plugin-made-to-order`**, and it is the proof
ADR-0014 asked for rather than a feature — *if made-to-order cannot be expressed as a strategy
Plugin, the strategy interface is wrong.* It offers three things and the reference Project wires
all three: a migration set, the Strategy (`requiresShipping`, no Inventory, a Lead Time), and a
Step that fills `place-order`'s `apply-adjustments` slot and turns a requested lead time into an
**Adjustment** on the Order (ADR-0022). That Step reads the lead time out of the **open**
Workflow context — a number Core has never modelled — which closes ADR-0013's scenario end to
end for the first time. Two things about it are worth knowing before extending it: it decides
which lines to surcharge from `line.fulfilment.hasLeadTime` and **never from the Strategy's
name**, because a Strategy is named by the key a Project wired it under and so does not know its
own name; and the open context has **two halves** since #138 — the query string and an optional
`metadata` object on the request body — so its tests place Orders both at
`POST /store/orders?leadTimeDays=3` and with `{ cartId, metadata: { leadTimeDays: 3 } }`, and
the Step reads a lead time spelled either way.

**The two halves merge, and a key arriving in both is refused rather than resolved.**
`openMetadata(url)` is still `Object.fromEntries(url.searchParams)` and is the whole context
for a route that takes no body; a route that runs a Workflow *and* takes one — `POST
/store/orders` is the only one today — calls `openMetadataWithBody(url, body)` instead, which
returns a discriminated union — `{ ok: true, metadata }` or
`{ ok: false, collided }` — so a caller cannot merge and forget to ask. A collision is on the
**key name** and never on the value: `POST /store/orders` refuses it at **400
`metadata-in-both`**, naming every colliding key, before it claims the idempotency key, because
nothing was attempted. There is deliberately no precedence rule, since any of them would be Core
forming an opinion about an input it does not model — and a refusal can still become body-wins
later, where body-wins could never become a refusal. Two consequences for a Step reading the
context: a query value is always a **string** and a body value is whatever JSON it was written
as, so `@kobai/plugin-made-to-order` accepts `3` and `"3"` and nothing else; and **a credential
belongs on the body**, because a query string is written to access logs, proxy logs and the
`Referer` of anything a confirmation page loads. **Capacity is still out of scope** — the
Strategy says only *that* there is a Lead Time, never that a date can be met (ADR-0012).

### The API contract

**A route is a declaration, and the description is generated from it.** Core's HTTP surface
is an `OpenAPIHono` (`@hono/zod-openapi`): each route is a `createRoute({…})` object naming
its path, its security scheme, the body it takes and every status it answers with, and
`app.openapi(route, handler)` both serves it and puts it in the description. So `c.json(body,
status)` is typechecked against the schema the route declared — **a response the description
promises and the handler does not produce fails the build.** Do not add a route with a bare
`app.get(…)`; it would be served and undescribed, and `openapi.test.ts` fails when the
router's table and the description disagree.

**The surface is promised, so a rename on it costs a major** (ADR-0060). kobai's HTTP surface
is under Core's semver commitment — the paths and methods that exist, the fields a request
accepts and a response carries, the status each outcome is answered at, and the `reason` string
inside a refusal. **Renaming or removing any of those is a breaking change rather than a
refactor**, and nothing below can tell you so: the drift checks prove the description matches
the routes, never that the change was allowed. What may still arrive in a minor is additive, and
**ADR-0060's table is what says which** — but one edge of it belongs here, because it is the case
that looks additive and is not: a new `reason`, or a new status, turns an exhaustive `switch`
over a regenerated `@kobai/client` into an incomplete one, so an addition is owed a written note
in the release too. Prose is not promised — a refusal's `error`, a route's `summary` and
`description`, and the description's own serialisation. The licence that makes any of this free
until the first publish is ADR-0058's. Read both before editing `contract.ts`;
`docs/extension-points.md` is where the same promise is written for a Developer.

The schemas live in `packages/core/src/http/contract.ts` and are **structural** — names,
types, presence, closed sets. Rules stay in the module that owns them: whether an address
looks like one, whether a SKU is taken, whether this Store prices in that currency. A rule
that moved into a schema would be one a client could be told about but Core could no longer
change.

**One schema and two routes are built per instance, and only these.** `Session`'s description
carries the deployment's own session lifetimes, which a Project may set (ADR-0050), so
`contract.sessionSchema(policy)` is a function and `admin.ts`'s two `/admin/session` routes
take the schema it returns. Everything else on the surface stays a module-level constant —
reach for this only for a route whose *description* depends on how the deployment was
configured, and never as a way to make a route's shape conditional: a description that
enumerated different paths per deployment is not a contract.

**Drift fails the build, in two places.** `packages/core/openapi.json` and
`packages/client/src/schema.ts` are both generated and both checked in.
`packages/core/src/http/openapi.test.ts` regenerates the description and compares;
`packages/client/src/schema.test.ts` regenerates the client and compares. Both run under
`devbox run ci`. Regenerate with `devbox run openapi:generate` — Core first, then the client,
because pnpm walks the workspace in dependency order.

**A version bump in `packages/core/package.json` drifts the description too** (#158). `info.version`
is `coreVersion()` in `http/app.ts`, read from Core's own manifest when the document is built,
because ADR-0060 makes the surface's version the package's — one fact, not a second copy kept by
hand. The checked-in artifact only moves when somebody regenerates it, so **bumping the version
without running `devbox run openapi:generate` fails `openapi.test.ts` twice**: once as a byte
diff, once as an assertion naming both versions. The asymmetry is the part that surprises people
and it is verified rather than assumed — **`packages/client/src/schema.ts` does not move**,
because `openapi-typescript` emits paths, components and operations and never the `info` block,
so a regenerated client is byte-identical across a version bump.

**Every list route pages, and there is one way to do it** (ADR-0064). `?limit=` and `?after=`,
an **opaque** `nextCursor` beside the items, no offset and no total — on the three lists that
exist and on every one added after them, because a surface where some lists page and others do
not is one a client has to learn twice. A new list route therefore takes
`request: { query: contract.PageQuery }`, declares `400: PAGE_QUERY_INVALID`, answers with
`{ …items, nextCursor: page.nextCursor }`, and reads its page through
`packages/core/src/db/page.ts`. Five things about it are decisions rather than implementation:

- **`nextCursor` is absent on the last page and that is the only end-of-list signal.** A short
  page is not one — a filtered page can be short and not last — so a reader fetches `limit + 1`
  rows through `pageSize`/`takePage` and reports a cursor exactly when the extra row exists. A
  count would be a second query over the whole table to answer a question with two answers.
- **The ordering ends in `id`, and the cursor is the same pair.** #132 already paid for a tie
  once, where it made the upgrade gate red *sometimes*; at a page boundary a tie skips or
  repeats a row instead of merely reordering it. `0028` indexes `(created_at, id)` on the three
  tables — ascending though every reader wants descending, because one ordering reversed whole
  is a backwards scan of the same index.
- **The cursor carries the timestamp as Postgres's own text, never a `Date`.** A `Date` holds
  milliseconds and `now()` holds microseconds, so a cursor round-tripped through one would fall
  on the wrong side of its own comparison and hide every row sharing that millisecond. That is
  why each paged query selects `cursorAt(column)` beside the `created_at` its response reports:
  two readings of one column, because the wire wants an ISO string a person reads and the
  cursor wants what the database is ordering by.
- **A `limit` over the ceiling is refused, never clamped**, and an `after` that does not decode
  is refused too — both as the existing `invalid` at 400, from `PageQuery` itself, because an
  unusable parameter does not fit the endpoint's schema and needs no `reason` of its own. A
  caller that asked for 5,000 and received a hundred would read the short page as the end.
- **The default and the ceiling are promised** (`DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT` in
  `db/page.ts`, 20 and 100) and each route's description says so, because changing either
  changes what an existing client receives.

`packages/core/src/http/pagination.test.ts` holds all of it, and holds it **once for the three
lists**: `LISTS` is a table of path and item key, so a new list added there inherits the whole
contract rather than a copy of it. Its last case is the one that matters and the one nothing
else can see — a page fetched across a concurrent insert — and it was watched failing against
an offset implementation first, which is the discipline the two race tests already use.

**One route answers a list and does not page, and the boundary is written down** (ADR-0067).
`GET /admin/fulfilment-strategies` hands back every Strategy this deployment has wired, in one
response, with no `limit`, no `after` and no `nextCursor`. It is the only exception there is and
it is not a precedent to copy loosely: ADR-0064's whole argument is about **rows arriving
between one page and the next**, and this set is `Object.keys` of what `kobai.config.ts` wired —
decided at boot, unable to change while the process runs, with no `created_at` a cursor could be
built over. **The test is "can this set change under a reader", not "is it small"**:
`GET /admin/roles` pages although a deployment may have three Roles, because a Merchant can
create a fourth over HTTP while somebody is paging. **A borderline case is a list route**, since
paging something that did not need it costs a parameter nobody sends and the reverse costs a
break. Adding a second unpaged plural route means reopening ADR-0067, not following it.

**A correction is a `PATCH`, and there is one way to do that too** (ADR-0062). Three routes
correct a record that already exists — `PATCH /admin/products/{id}`,
`PATCH /admin/variants/{id}` and `PATCH /admin/store` — and they behave identically on purpose:
**an absent field means "leave it"**; a named `metadata` is **replaced** and never merged,
because a merge leaves no way to take a key back out; and **a body naming nothing the route
would change is refused at 400** rather than answered 200 with the row unchanged. That refusal
does a second job at all three, because the schema strips a field the route does not carry — a
Merchant who sent a Price to a Variant, a `variants` to a Product or only a `defaultCurrency` to
the Store sent an empty body, so the refusal is where they are told which route does it. A `PUT`
beside them is a different judgement and needs one: `PUT /admin/variants/{id}/inventory` stays a
`PUT` because a count *is* the whole fact.

**A Store's default currency does not move** (ADR-0065). `PATCH /admin/store` accepts a
`defaultCurrency`, takes the code the Store already prices in — so a form submitting the whole
record round-trips — and refuses any other at **422 `default-currency-is-fixed`**, whether or not
a single Price has been written. Every Price carries the Store's default and no other (#5), so
moving the column reinterprets each of those amounts rather than converting them, and ADR-0008
already says where multi-currency arrives: as more rows. **Do not add a currency-change path,
and do not narrow the refusal to "when Prices exist"** — relaxing it later is cheap, tightening
it is a break (ADR-0060), and the narrow version is a read of `core_price` followed by a write.

**A Role is a row a Merchant can make, and one Permission administers every change to one**
(ADR-0066). `POST`/`GET`/`PATCH`/`DELETE /admin/roles` and `GET /admin/merchants` are #173's six.
The three **writes** sit behind **`merchant:write`** and there is deliberately no `role:write`
beside it: a Merchant who may add a colleague may add one against `owner`, so that Permission is
already the power to administer access entire, and a second word would name a boundary that does
not exist. The three **reads** — `GET /admin/roles`, `GET /admin/roles/{id}` and
`GET /admin/merchants` — sit behind
**`merchant:read`**, because that argument reaches the writes and stops there. Seeing the roster
escalates to nothing, and gating it on the write meant granting the power to change who has
access in order to let somebody see it; `merchant:` would also have been the only family here
with a write and no read. Four things about that surface are decisions and not implementation:

- **A read is `merchant:read` and a write is `merchant:write`, and neither moves.** Which gate a
  route sits behind is promised surface (ADR-0060), so a route added here takes the one its verb
  says — a new write, `DELETE /admin/merchants/{id}` included, needs no Permission of its own.
- **A Permission Core has never heard of is stored, not refused.** `permissions` is an array of
  non-empty strings and nothing checks *which* strings — a shape, not a vocabulary. `Session`'s
  own description already promises this ("a deployment may hold a permission this build of Core
  has never heard of"), and closing the set would foreclose a Plugin-supplied Permission before
  anybody has designed one. **Do not validate against `PERMISSIONS`**; the Admin's picker is
  where a typo is caught, as an affordance (ADR-0063).
- **The last Merchant able to administer Merchants cannot be stripped.**
  `PATCH /admin/roles/{id}` refuses at **422 `last-administrator`** when the change would leave
  no Merchant holding `merchant:write`, because the first Merchant is seeded only while there is
  none (ADR-0041) and the way back would be raw SQL. **The guard is a `pg_advisory_xact_lock`
  taken before the read, not a conditional update** — the condition is about *other* rows, which
  a subquery does not lock, so ADR-0018's one-statement answer does not reach it and two requests
  each stripping a different last administrator would both commit.
  `packages/core/src/auth/the-last-administrator.test.ts` is the concurrent test, and it has been
  watched failing with that line removed.
- **A Role Merchants hold is refused rather than cascaded or reassigned** — **422 `role-in-use`**,
  ADR-0059's shape reached through `core_merchant.role_id`'s `on delete restrict`. The delete is
  one statement and the violation is *read* (`violatesForeignKey`), not asked for first: a
  `select` then a `delete` lets a concurrent `POST /admin/merchants` slip a holder in between.

**A route needing a Permission Core does not define yet brings one with it**, which is one edit
and one migration. The new string goes **last** in `PERMISSIONS` (`auth/permissions.ts`), because
`ALL_PERMISSIONS` is that literal's declaration order and `auth.test.ts` holds the seeded `owner`
Role equal to it; then a `--custom` migration appends it to `owner`, the way `0029` and `0030`
do. Skip the migration and every deployment that upgrades gets a route nobody can call. **The
read/write split is the house rule** — `store:read` is not `store:write`, as `catalog:`,
`api-key:` and `merchant:` already are — because which gate a route sits behind is promised as
well (ADR-0060), so gating a write behind a read permission is a break to undo rather than a
decision to take, and gating a read behind a write is granting the power to change a thing in
order to let somebody see it. `order:read` stands alone only because an Order is immutable
(ADR-0009), so there is no write for a Permission to gate.

**A declared refusal must have the gate that makes it.** Five of the statuses a route
declares are not the handler's to answer — they are made above it, by middleware: `503` by the
migration gate, `401` by the session gate at `/admin` and by the API-key gate at `/store`,
`403` by `requirePermission`, and `403` again by `requireSecretApiKey` on the `/store` routes
that take money (ADR-0055). **The two `403`s are two entries in `GATE_REFUSALS`, deliberately**
— one is a Merchant's Role being too narrow and the other is a browser's key on a route it may
not open, so sharing an entry would let a route declare one and be gated by the other.
Nothing the compiler does can see any of them, so each gate is built
through `gateAnswering` (`packages/core/src/http/gate-refusals.ts`), which marks it with the
refusal it makes, and `openapi.test.ts` reads the marks back off **Hono's own route table** —
the thing dispatch reads — and holds every operation to declaring exactly the refusals its
chain can answer. Both directions fail: a declared `403` with no `requirePermission` promises
a check that does not exist, and a gate whose route declared no `403` hides a refusal a
generated client cannot narrow on. Gating a route stays `middleware:
[requirePermission(…)] as const` on the declaration and nothing else — **nothing is registered
twice**, and a new gate needs one entry in `GATE_REFUSALS`.

The check deliberately covers **all of them**, not just the `403` #56 asked for: the session and
API-key gates are mounted per surface with `use("*")`, so the mistake they catch is a route
registered on the wrong half of `admin.ts` — anonymous access to the admin surface, which
nothing else here would notice. It stops at the status: the *reasons* inside a refusal are
pinned one level down, in `contract.ts`, and **a reason a module refuses with is bound to that
module's own union by a mapped `satisfies`** — so the declared set is exactly the refusals that
module can make, a new one has no key and does not compile, and a rename turns `contract.ts` red
naming the word. `SESSION_REASONS` and `API_KEY_REASONS` are the two gates'; #149 built the rest
of Core's the same way (ADR-0060). **Read the file rather than counting them here**, because the
construction is not uniform and each departure has a reason. A reason written *above* every
handler has no module to map over: `REQUEST_REASONS` is `invalidRequestHook`'s and
`app.onError`'s two, spread into every family a body can reach. A reason a **handler** writes by
hand is bound instead by the schema it is typechecked against — `ApiKeyNotFound`'s `z.literal`
answering the handler's own `reason: "…" as const`, `OrderRefusal`'s one-member enum,
`PlaceOrderRequestRefusal`'s `metadata-in-both` — where a rename on either side still fails the
build, which was checked rather than assumed. And the two families a **Step** refuses through —
`PriceRefusal` and `PlaceOrderRefusal` — keep `reason` an **open string**, because closing them
would close Extension Point 2; Core's own words are listed in each schema's `description`, built
from the constant rather than retyped, and that constant *is* held to the modules' unions by the
same mapped `satisfies`. **No route is excused.** `POST /admin/merchants` was the
one that had to be, because the first Merchant had to be creatable with no session at all, so
it asked the same question inside its handler; #25 moved the first Merchant to a boot-time
seed and the route took the ordinary middleware, so every refusal every operation declares is
now made by a gate this check can see.

**The description is not served.** `/store` refuses an unauthenticated request *before*
saying whether a path exists, and an endpoint handing out the whole surface anonymously would
undo that. A Developer reads it from the package (`@kobai/core/openapi.json`); a TypeScript
one installs `@kobai/client`.

**A path no route serves is a refusal too, and it is not in the description.** One
`app.notFound` in `app.ts` answers every unrouted path — on both surfaces and at the root —
with the same `{ error, reason: "not-found" }` at 404, because a client that got JSON for
every failure it could anticipate and plain text for the one it could not would find out at
runtime (#33). It is a handler rather than a route, so it is deliberately absent from the
description: a description enumerates the paths that exist. It also runs *after* both
credential gates, which are mounted `use("*")` and therefore answer before routing — so an
anonymous caller gets 401 for a nonexistent admin path, not 404, and cannot map either
surface. That ordering is a decision, not an accident; ADR-0040 says where the line is.

`openapi-typescript` is pinned to **6.7.6, exactly**, and `.github/dependabot.yml` holds the
major back. Version 7 builds its output with the TypeScript compiler API and TypeScript 7
ships none — see below.

### The Admin

**The Admin is vendored source, not a dependency** (ADR-0010, ADR-0033). It lives at
`reference/admin/` — React on Vite, Tailwind v4, shadcn/ui on **Base UI** — and every
component under `src/components/ui/` is an ordinary file in this repository because that is
how shadcn works: `shadcn add` copies source in. Edit them. Add another with

```sh
devbox run -- pnpm --filter kobai-reference-admin exec pnpm dlx shadcn@latest add <name>
```

and move whatever it writes into `dependencies` over to `devDependencies` — the whole
frontend toolchain is bundled at build time, so none of it belongs in the shipped image.

**One process serves both.** `reference/src/app.ts` asks one question — is this path the
Admin's? — and hands everything else to `kobai.fetch` untouched. The Admin is at
`/admin-ui`, deliberately **outside** `/admin`: the session cookie's default-path is the
admin surface's directory (ADR-0032), and a cookie path matches only at a `/` boundary, so no
asset request carries the credential. Beware that `/admin` *is* a bare string prefix of
`/admin-ui` — match on the path boundary, never on `startsWith` alone.

**There is no CORS configuration in this repository, and adding one is a wrong turn.** One
origin is what ADR-0010 spends the single container on. The dev loop keeps it: `devbox run
admin:dev` is a Vite server that **proxies** `/admin`, `/store` and `/health` to the Project,
so the browser still sees one origin while editing.

**The Admin may use only the public API, through `@kobai/client`.** No raw `fetch`, no
`@kobai/core` import, and no route that exists for its benefit — if the Admin needs something
the API cannot do, that is a finding about the API (ADR-0010).
`tests/admin-uses-only-the-public-api.test.ts` fails the build on any network primitive in
the Admin's source and on any kobai path `openapi.json` does not carry. That is a static ban:
it proves the Admin cannot cheat and nothing whatever about whether it works. What proves the
second is the browser seam below.

**The Admin is tested in a real browser, in the gate** (ADR-0063, #175).
`tests/the-admin-in-a-browser.test.ts` drives Chromium against a really-booted reference
Project — `node dist/src/server.js` against a throwaway database, on a port the OS hands out —
and `tests/support/admin-browser.ts` is the harness, which says in its own header how to add a
case. `devbox run browsers` downloads the browser and `devbox run ci` and `devbox run test`
both run that themselves, for ADR-0044's reason: a guardrail behind an opt-in step is not a
faster guardrail, it is an optional one. Five things about it are decisions rather than
implementation:

- **It asserts the frame's promises and never screen behaviour.** Deep-linking, refresh,
  browser back and forward, a session running out mid-use and the Merchant landing back where
  they were, a refusal rendering where it was attempted, skeleton, spinner and empty states,
  and what a narrow Role is offered — which sections, which actions, and that an unavailable
  one really does nothing (`seam.merchantOnARole`, `seam.signedInAs`). **A case that a request-level test could have asked belongs there instead**, which
  is where screen behaviour has always been asserted. The catalog cases (#179) are the same
  test applied to a busier screen: a **refused** deletion staying in its dialog, a delete
  control offered although the deletion is about to be refused, and — the one nothing else in
  this repository can ask — **which requests the Admin made and in what order**, which is how
  "superseding a Price adds the new one before removing the old" becomes an assertion rather
  than a claim in a comment.
- **A visible overlay is not the same as a settled one, and an assertion about a dialog goes
  after the audit.** A closing dialog *fades*, so it stays mounted and visible for the length of
  `data-closed:animate-out` — long enough that "the dialog is still open" passed against a
  `ConfirmDelete` that closed on every answer. `auditAccessibility` waits for every animation
  that will end to have ended, so putting it first is what makes the line after it mean
  something. **Assert on a dialog's presence only once something has waited for the animation.**
- **`axe-core` runs on every screen a case visits and any violation fails the build.** It is a
  call per screen rather than per case, so a case that navigates twice audits twice — and an
  **overlay is a screen**, so a case that opens the command palette audits it open, which is a
  different surface from the page under it. The audit waits for every animation that will end to
  have ended, because it measures pixels: half way through the palette's fade its group heading
  read 4.1:1 against a threshold of 4.5, on colours that pass everywhere once they have settled.
  An animation that repeats for ever is skipped rather than waited on, or the boot gate — whose
  only content is a `Spinner` — would hang instead of being audited.
- **The keyboard assertions are not padding, because a scanner sees none of them.** Reaching a
  control is `tabTo`/`keyboardTo`, which press a key until the control has focus and fail
  naming where the keyboard got to instead — `Tab` walks the page, `ArrowDown` walks an open
  menu. Focus after a re-sign-in and the `aria-disabled` controls that stay focusable so they
  can host the explanation of why they are unavailable (#178) are keyboard decisions, and all
  arrive here. **An unavailable control is asserted twice**, because the tooltip and the
  announcement are two different things: what a mouse sees is the popup, and what a screen
  reader is told is the `aria-describedby` the component wires itself, since Base UI's tooltip
  gives its popup no `role="tooltip"` and associates it with nothing. **The command palette is a combobox over a listbox**, so the arrow keys move the
  *selection* while the keyboard stays in the input — its list is asserted on `aria-selected`,
  which is what a screen reader announces, `tabTo` is for reaching its button, and where the
  keyboard ends up after it closes is asked with `isFocused`.
- **Arrange through the API and open a window per case.** Every case gets its own browser
  context — its own cookie jar, its own `localStorage` — so nothing one case leaves behind is
  reachable from another; the *catalog* is shared, because a boot per case is not affordable,
  so a case names its own titles and calls `emptyTheCatalog` when an empty list is its subject.
  Time is passed by winding `core_session.expires_at` back, never by waiting.
- **The browser is Chromium's headless shell**, which is what `--only-shell` downloads and what
  `channel: "chromium-headless-shell"` launches — since Playwright 1.49 a bare `headless: true`
  asks for the full browser, which is deliberately not downloaded. The flag and the channel are
  one decision in two files and the seam's first case holds them together.

One thing in the Admin looks like an oversight and is not: `Pager`'s dead Next/Previous use
real `disabled` rather than `aria-disabled`, deliberately, because there is no explanation to
host on one. The same goes for every control dead only while a request is in flight.

**Every screen is on the frame, and a screen takes no props** (#176). A screen is a component a
route names and nothing else: it reads its identifier from the router (`lib/route.ts`'s
`useRouteId`, which is where react-router's `string | undefined` is settled once), its client
from `useKobaiClient`, and its data through TanStack Query. `app.tsx` therefore holds paths and
components, with no adapter in between — the four wrappers that pulled a client and a
back-navigation callback out of context and handed them down as props are gone, and a new one
would be the pre-frame shape coming back. **A form field is
`components/form-field.tsx`** — a label, an input and the schema's message, in one place because
the invalid state has to be set twice (`Field` reads `data-invalid`, the `Input` announces
`aria-invalid`) and an `id` is unique to the document rather than to the form it is in. Six
further things about the screens are conventions rather than one screen's choice:

- **Every list pages through the cursor, with the cursor in the URL** — Products, Orders and
  API keys alike, through the one `components/pager.tsx`. A list route that took no page would
  be a screen on which the older half of a Store cannot be reached, and API keys is the
  non-obvious one: the storefront price preview mints a publishable key per browser session
  that has none, so they accumulate without anybody minting one on purpose.
- **A closed refusal family is narrowed, never matched on prose.** `lib/refusal.ts` holds one
  `Record` per family keyed by that family's own union and a `narrowing()` built from it, so a
  `reason` added in Core has no key, does not compile, and reddens the Admin in the same commit
  (ADR-0063). The screen's `switch` ends in `const unreached: never`, which is what holds the
  arms complete. `PriceRefusal` and `PlaceOrderRefusal` keep `reason` open and take `messageOf`
  **by design** — closing them would close Extension Point 2.
- **A refusal a Merchant can act on gets a screen; the rest get an `Alert`.**
  `product-not-found` and `order-not-found` render an `Empty` with a way back to the list,
  because the only useful next move is to leave the address. Nothing predicts a refusal: every
  one is the answer to a request that was actually made.
- **The document outline lives in the frame.** The layout's `h1` names the **section**, so a
  detail screen's record title is an `h2`; the screens rendered *in place of* the routes —
  sign-in and the boot gate — carry their own `h1`, because there is none above them to inherit.
  A detail screen names its own breadcrumb through `lib/crumb.tsx`'s `useCrumbTitle`, which
  flows up rather than down: the layout owns the state and the screen writes it, because
  `GET /admin/orders/{id}` is what knows the number and a layout that fetched one would be
  fetching it twice.
- **What the Admin's sections are is `lib/sections.ts`, and there is one of it** (#177). The
  sidebar draws one entry per section and the command palette — ⌘K and Ctrl+K, built from
  shadcn's `command` — offers one row per section, and a list living in either would have been
  copied into the other. **That module is also where the sections a Role cannot read are
  hidden** (#178): `useSections` narrows the one list, never a permission check inside each
  entry — and `app.tsx`'s front door redirects to the head of *that* list, so the address
  nobody chose cannot be one this Merchant would meet a refusal on. The palette
  is the one navigation affordance a Plugin-contributed screen could use without renegotiating
  the sidebar (#71 is still open), which is why the list is data rather than markup. It closes
  onto the button that opens it — `finalFocus` on the popup, which is why it composes `Dialog`
  rather than taking `CommandDialog` whole — because choosing a section unmounts the screen
  focus would otherwise return to.
- **A permission check in the Admin is an affordance and never a boundary** (#178, ADR-0063).
  `requirePermission` in Core is the enforcement; `lib/permissions.ts` is where that is written
  down at length, because the next person to read one of these checks will assume it is doing
  security work — and would then be right to wonder why it is cached at all. Four things follow.
  **The set of Permissions is open**, so a Role's are asked by `permissions.includes(…)` and
  never as a union or a `switch`: `Session`'s own description says a deployment may hold a
  permission this build of Core has never heard of. **A section is hidden and an action is
  shown**, because a screen that 403s on load teaches nothing while a hidden button leaves a
  Merchant no way to learn the Permission is a thing to ask for. **An unavailable action is
  `aria-disabled`, never `disabled`** — a truly disabled control takes no focus and fires no
  pointer events, so it can host no tooltip and cannot be reached to be told why — which means
  the handler has to genuinely no-op, and `components/action-button.tsx` is the one place that
  is done. A form around one needs no guard of its own: a browser performs implicit submission
  by clicking the form's default button, so Enter in a field arrives at the same handler, and
  the second guard written for it was taken out again after no case could see it go. **The
  session query is re-read on navigation as well as on focus**, through
  `useSessionOnNavigation`, and **on focus explicitly rather than by inheriting TanStack
  Query's default**, because `app.tsx` sets `defaultOptions` for that cache and a line there
  could otherwise take half of this away in silence. Both halves are asserted in the browser.
- **A contrast failure is fixed in the token layer.** `--destructive` is darker than shadcn's
  default because `text-destructive` on `bg-destructive/10` — every destructive control in this
  distribution — measured 3.99:1; `src/index.css` carries the measurement at the value. Tuning
  the two vendored components instead would have been undone by the next `shadcn add`, and
  would not have reached the components not added yet.
- **A deletion is `components/confirm-delete.tsx`, and it stays open when it is refused** (#179,
  ADR-0059). Catalog deletion refuses rather than cascading — `last-variant`,
  `stock-is-reserved` — so a delete control that looks perfectly available can still come back
  turned down, with the Merchant standing in the modal. So there is one component and it gets
  four things right on everybody's behalf: **only success closes it**, the refusal renders
  **inside** it, the previous attempt's refusal is cleared **when it is reopened** rather than
  when it closes, and its trigger is an `ActionButton` rather than an `AlertDialogTrigger`, so
  an unavailable delete opens nothing. **There is no `canDelete` prop and there must not be
  one**: whether stock is reserved is a rule living in Core that a Project may already have
  changed through a replaced Step, so the Admin attempts and renders the answer.
- **A picker over a set kobai can name is read from kobai, never written down here.** The
  Fulfilment Strategy field reads ADR-0067's route, because `physical` and `digital` in a
  `const` is ADR-0014's closed set moved into the client. It is the same rule as
  `lib/refusal.ts`'s `Record`s one step out: the Admin may hold what kobai's *types* close, and
  must ask about what a deployment decides. **A documented default is not the set**, which is
  the one thing that may still be a constant: `DEFAULT_STRATEGY` is `physical` because
  `CreateVariantRequest` promises "Defaults to `physical`" under ADR-0060, so a new Variant
  starts on the Strategy the same request without that field would have got. Starting on the
  first name the route answers with was the alternative and is worse — it is alphabetical, so
  the picker would default to `digital`.
- **A field whose options are still loading must not say the value is wrong.** The "not wired
  here" option is gated on the query having **succeeded**, not on the name being absent from an
  empty list — otherwise every ordinary `physical` Variant is labelled broken for the length of
  a round trip, and permanently if the read fails, which announces exactly the state the screen
  exists to repair about a Variant that is fine. The value is still rendered as an option while
  the list is in flight, because a `<select>` whose value matches no option shows nothing and
  reports `""`.
- **A popup that portals lands in the frame's container, not in `<body>`** (#179).
  `lib/portal.tsx` is the whole argument and `components/app-layout.tsx` renders the container
  inside `main`. Base UI moves a `Select`'s list and a `DropdownMenu`'s items out of the card
  they were opened from so they escape its `overflow` and stacking context — right about
  clipping, wrong about *content*: at the default target they sit outside every landmark, which
  `axe-core` reports as `region`. **The browser seam audits screens with an overlay open, so
  this fails the build**, and the theme menu had been shipping that violation since #176 with
  nothing opening it. `ui/select.tsx` and `ui/dropdown-menu.tsx` therefore take a `container` and
  default it to the frame's — the one change to what a vendored component *does*, recorded in
  `components/ui/README.md` and at each line. **A `Dialog` needs none of this**: axe excludes a
  `role="dialog"` subtree from the rule, so `ui/dialog.tsx` and `ui/alert-dialog.tsx` are
  untouched. **Vendor a new component that portals and it inherits this**, provided its
  `Content` passes `container` on; a new one that does not will be found by the first case that
  audits it open.
- **A control that is not an `<input>` is driven with `useController`, never a `useState`
  beside the form.** The Fulfilment Strategy picker is a listbox, so it cannot be `register`ed —
  but the form still owns the value, which is what keeps its validation, `formState.errors` and
  `reset` working like every field next to it.
  **A second one factors this out of `components/fulfilment-strategy-field.tsx`**; reaching for
  the vendored `Select` instead means answering the landmark question first.
- **Card titles are headings on the Product screen and on no other.** The frame's `h1` names the
  section and a detail screen's `h2` names the record, so the cards under it are `h3` — but only
  where the cards are *sections of one record*, which is the Product screen and its repeated
  Variants. A screen whose cards are a list of records is right to have none. `CardTitle` is a
  `div` in this distribution and is left alone; the heading is an element inside it.

### The scaffolder, and the two trees it keeps in step

**`reference/` is the source; `packages/create-kobai/template/` is generated from it.** Edit
the Project the maintainers actually boot, then run `devbox run template:generate`. The gate
fails until you do — `tests/create-kobai-matches-the-reference-project.test.ts` regenerates
the template and byte-compares it with what is checked in, exactly as `openapi.test.ts` does
for the description. **Never hand-edit anything under `template/`**; the next regeneration
deletes it.

Every legitimate difference between the two trees is a named entry in
`packages/create-kobai/src/adaptations.ts`, and the test fails on any other difference in
either direction, a file existing in only one tree included. **That list is the whole
guarantee, so it is deliberately short and its length is asserted.** If a change seems to
need a new entry, check first whether it belongs in the reference Project instead — anything
shared should live where it is booted and tested, not in a template nobody runs.

**kobai's packages are published** (ADR-0034). `@kobai/core`, `@kobai/plugin-price-log`,
`@kobai/plugin-made-to-order`, `@kobai/client` and `create-kobai` are at `0.1.0` and are no
longer `private`, because a generated Project depends on them as ordinary versioned
dependencies and `workspace:*` resolves nowhere outside this workspace. **A package the
reference Project depends on has to be published, and it is named in exactly one place:**
`PUBLISHED_KOBAI_PACKAGES` in `packages/create-kobai/src/adaptations.ts`, which is what makes
a generated Project ask a registry for a version rather than for `workspace:*`. Every
acceptance test that stands a registry up
(`tests/a-generated-project-boots.test.ts`, `tests/a-project-boots-from-its-own-compose-file.test.ts`,
`tests/the-upgrade-gate.test.ts`) fills it through `publishedKobaiPackageDirectories()` in
`tests/support/workspace.ts`, which places each of those names in the workspace with `pnpm
list`. It used to be four copies of the list, and a package added to one and not the others
failed deep inside an install with a 404 naming the registry rather than the list it was
missing from (#129). Nothing has actually been released; choosing a release process is a
separate decision.

What stands where `private: true` stood is `publishConfig.registry`, pinned at a loopback
address in every publishable manifest, and `tests/publish-guard.test.ts`. **npm resolves the
publish target from `publishConfig.registry` before it opens a connection, and that value
beats both `--registry` and `npm_config_registry`** — so a publish to npmjs.com has to be
deliberate, and CI publishes by packing a tarball and passing `--registry`, which is the one
form that honours the flag. **Taking that pin out is the act every obligation kobai has taken on
the strength of nothing having been published falls due on**, and
[ADR-0061](docs/adr/0061-what-the-first-publish-owes.md) is the one list of them — a first
publish starts by reading it, and adding to it is three edits: the section there, a pointer in
whatever argues the obligation, and an entry in `OUTSTANDING` in `tests/publish-guard.test.ts`,
which holds those two ends together. Closing
[ADR-0058](docs/adr/0058-a-promised-surface-may-be-broken-until-the-first-release.md)'s licence
is one entry on that list rather than the whole of it. **The gate cannot say an entry has been
discharged and deliberately does not try**: what it holds is that the list is complete and
reachable from every end, and the refusal a publisher meets in `publish-guard.test.ts` names it.

The acceptance test stands up a real registry — `tests/support/local-registry.ts`, verdaccio
on an ephemeral port, holding this commit's packages — generates a Project, installs, builds
and boots it. It is a module rather than a detail inside one test because **#12's upgrade
gate reuses it** to bump Core across a synthetic major.

**A generated Project is the root of its own two-package workspace**, so `pnpm -r` skips it:
every recursive command in a Project needs `--include-workspace-root`, or it silently builds
only the Admin and leaves no `dist/src/server.js` behind.

**What is correct here is not automatically correct in the tarball.** npm strips a
`.gitignore` out of every package it builds — silently, and regardless of `files` — so the
Project's was present in this repository, asserted by every drift check, and missing from
what a Developer would have installed. Dotfiles are therefore stored in `template/` *without*
the leading dot and `scaffold` puts it back; `DOTFILES_STORED_DOTLESS` names them. The drift
suite packs `create-kobai` for real and reads the tarball back, which is the only assertion
that can see this class of bug at all.

**`biome.json` excludes `packages/create-kobai/template`**, and cannot say why in itself — a
comment in that file stops Biome parsing its own config. The reason: the template is a
generated artifact like `openapi.json`, and `jsonc-parser` re-prints an edited `tsconfig`
with slightly different wrapping than Biome would, so formatting it would fight the
byte-comparison that keeps it honest.

### Upgrading a Project, and the codemods that do not exist yet

`@kobai/core` ships a bin, **`kobai-upgrade`** (ADR-0035). It moves every `@kobai/*` range in
a Project, installs, and runs the codemods **the version being upgraded to** ships. Three
things about it are easy to get wrong and expensive to discover late:

- **The set is keyed to the version that broke something**, not to a `from → to` pair.
  `Codemod.introducedIn` names it and the runner takes everything in `(from, to]`, in order,
  so a Project jumping two majors runs both without anybody having enumerated the pair. A
  `0.x` minor counts as a major, because `^0.1.0` means `>=0.1.0 <0.2.0`.
- **The set is read from the version arrived at, and Node's resolver cache will hand you the
  one before it.** `require.resolve` caches by specifier and search path, so the same lookup
  either side of an install returns the same package. The first version of this command
  reported the old version as the new one and would have run its codemods — invisibly, because
  at an empty boundary both sets are empty. The installed package is therefore read off the
  filesystem at `node_modules/@kobai/core`, and the set resolved from *inside* it, where
  pnpm's real path carries the version.
- **The set is empty and the command says so.** "Nothing to do" and "did nothing" are
  different answers, and only the first tells a Developer the command would have spoken up.
  There are three outcomes and they must stay three: codemods ran, none applied to this
  boundary, or the set could not be read. A set that is present and wrong about itself —
  an unreadable `CODEMOD_SET_FORMAT`, an unorderable version — **fails the command**; only an
  absent set is survivable, and even that exits non-zero. The command has one argument and no
  way to skip the install, because either would be an upgrade that quietly ran no codemods.
- **Its install is the one install in kobai that may move `pnpm-lock.yaml`**, and it runs
  `pnpm install --no-frozen-lockfile` to say so. The ranges have just changed on purpose, so
  the lockfile is stale *by construction* — and **pnpm freezes by default whenever `CI` is
  set**, which made this green on a Developer's machine and red in GitHub Actions with
  `ERR_PNPM_OUTDATED_LOCKFILE`. The gate therefore runs the upgrade with `CI=true` so that
  environment exists locally too. Everywhere else a stale lockfile is an accident and
  refusing is correct: do not spread the flag, and never fix this class of failure by
  clearing `CI` for a child process — that hides it from every Developer's CI, which is where
  an upgrade failing costs the most.

**Do not reach for an AST tool to write a codemod without reopening ADR-0035.** A codemod
gets the Project's directory and `node:fs`, which is all a manifest-level migration needs;
TypeScript 7 ships no compiler API and #28 rejected pinning a second one, so rewriting a
Developer's TypeScript is a dependency decision nobody has taken.

The **upgrade seam** is `tests/the-upgrade-gate.test.ts`, and it is the release gate ADR-0029
asks for: a generated Project — which *is* the reference Project — is arranged through the
public API, taken across a **synthetic major** manufactured by republishing this commit's
packages under another version, then rebuilt, rebooted against the same database, and asked
every question it was asked before. **It asks several, and each is one clause of ADR-0001's
promise**: that the shipped command moved every `@kobai/*` range, installed it, rewrote
`pnpm-lock.yaml` and reported both the codemods it found and the lockfile it touched; that the
Project still boots and still applies every migration set into the database it already had;
that the Step it put in Core's `select-price` slot still decides the price; that the Plugin's
tables, its rows and its migration tracking survived *and its offered Step is still writing to
them*, and that the Project's own tables survived too; that the Fulfilment Strategy a **Plugin**
supplies still answers, and the Step reading that answer still puts the Lead Time surcharge on
the Order; that the Payment Provider the **Project's own source** supplies still takes the
money; and — the strongest of them, and the one nothing else in this repository asks — that an
Order placed *before* the upgrade reads back **byte for byte** after it, the whole body of
`GET /store/orders/{id}` compared as text. So the gate carries both dependency-substitution
surfaces (ADR-0052, ADR-0053) and ADR-0009's immutability across a Core major, which is what to
weigh it as. Each assertion says which clause broke, because `exit 1` at three in the morning is
not a diagnosis.

**That byte comparison is only as stable as the read path underneath it**, so a query the Order
route reads through needs an `order by` that cannot tie — `readFulfilmentsOf` ends its one in
`id` for exactly that reason (#132), as the Line Item query beside it always did. A tie there
would not redden this gate honestly; it would redden it *sometimes*.

What the gate deliberately does not prove is that a codemod transforms anything — there is no
breaking change to migrate — and that is pinned against fixtures in
`packages/core/src/upgrade/codemods.test.ts`.


### Writing tests

The dominant seam is the **public HTTP API, dispatched in-process against a real Postgres**.
Reach for `createTestKobai` from `@kobai/core/testing`: it creates a throwaway database, runs
every migration set into it, and hands back an object you dispatch requests at.

```ts
import { createTestKobai, signInTestMerchant } from "@kobai/core/testing";

await using kobai = await createTestKobai(); // `using` drops the database on the way out
const merchant = await signInTestMerchant(kobai);
const response = await kobai.request("/admin/store", { headers: merchant.headers });
```

The **admin surface is closed by default, with no unauthenticated write path anywhere under
it** (ADR-0041): `/admin/*` sits behind a Merchant session, each route names the one
permission its Role must hold, and the *first* Merchant is the one thing a deployment is given
rather than asked for — seeded at boot from `initialMerchant`, because on a deployment holding
none there is nobody who could hold `merchant:write`. So `signInTestMerchant` **seeds** that
Merchant, exactly as a boot does (`seedTestMerchant` is the same call without the sign-in),
and then signs them in through the public API. There is no HTTP way to create the first one
and a test that reaches for `POST /admin/merchants` anonymously is asserting against a 401. A
test about *not* holding a permission should create a narrower Role itself — that is the
subject, and a helper would hide it; **that Role goes through `POST /admin/roles`** since #173,
never through `insert into core_role`, and that second Merchant goes through
`POST /admin/merchants` with the seeded one's session, which is the only way there is, and
`sessionOf(response)` reads the session cookie off their sign-in response the way a browser
would.

**`auth.test.ts` sweeps the whole admin surface** — every operation the generated description
carries, called with no cookie, asserted 401 — so a route registered on the wrong half of
`admin.ts` fails on the day it is written. Adding an admin route means moving the count that
sweep asserts, and that is the moment to check which half it landed on.

A session **is a cookie, not a bearer token** (ADR-0032). `merchant.headers` is
`{ cookie: "kobai_session=…" }` and the token is in no response body, so a test that reaches
for an `Authorization` header to open `/admin` is reaching for the transport that was removed.
The one exception is a test whose *subject* is that removal — `auth.test.ts` presents the
token as a bearer and asserts it is refused, because a gate that quietly kept accepting both
would pass every other test in the file.

The **store surface is closed by default too, behind a different gate**: `/store/*` sits
behind a bearer API key rather than a Merchant session (ADR-0020), so neither credential is
worth anything on the other surface — nor does either even arrive the same way.
`createTestApiKey` mints one through the public API, which means a Merchant has to be signed
in first:

```ts
const merchant = await signInTestMerchant(kobai);
const key = await createTestApiKey(kobai, merchant); // secret unless you ask otherwise
const price = await kobai.request("/store/variants/…/price", { headers: key.headers });
```

A test whose subject is the *kind* of key should ask for the kind it means
(`{ kind: "publishable" }`) and say why, rather than leaning on the default.

**The harness wires a Payment Provider, because Core ships none and almost no test is about
one** (ADR-0053). `createTestKobai` passes `testPaymentProvider` — takes every payment, gives
any of it back, remembers nothing — the same courtesy `silentLogger` is, and for the same
reason: without it every test that places an Order would be a test about not having a
provider. It is not a provider a deployment could use, and it is not what a test *about*
payment should reach for:

```ts
await using kobai = await createTestKobai({ payments: { provider: mine } }); // one of your own
await using none = await createTestKobai({ payments: {} });                  // a deployment with none
```

**Ask the provider what it is holding; never count that a callback was reached.** A refund is
the one thing `place-order` can undo, so a test about unwinding writes a provider that keeps
books and asserts on them — `packages/core/src/payment/payment.test.ts` is the shape, and the
distinction is the same one ADR-0036 draws for a compensation that throws: "the code ran" and
"the Shopper got their money back" are two facts, and a counter only ever knows the first.

**Almost every test needs something to sell before it can assert anything, and that
arrangement is one line.** `seedTestCatalog` creates a Product, the Variant that makes it
sellable and a Price on that Variant — through the public API, like everything else here, so
a Plugin's test is doing exactly what a Plugin can do — and signs a Merchant in and mints a
secret key on the way, because the catalog is reached through one gate or the other:

```ts
const catalog = await seedTestCatalog(kobai); // "A poster", one POSTER-A2, one Price of 1250

const price = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
  headers: catalog.apiKey.headers,
});
const product = await kobai.request(`/admin/products/${catalog.productId}`, {
  headers: catalog.merchant.headers,
});
```

**Amounts are integer minor units** — 1250 is USD 12.50 — and a Price's currency is the
Store's default, which since #5 is the only currency a Price may carry. So the helper takes
no currency at all: the correct thing is the only thing.

**Nothing it seeds is counted**, and there is deliberately no option that counts it. A Variant
with no Inventory row sells freely and holds no Reservation (ADR-0018), which is what every test
that is not about stock wants; a test that *is* about stock says so with
`PUT /admin/variants/{id}/inventory`, in the open, the way `reservation/reservation.test.ts`
does.

It hides the arrangement a test does not care about and **never the thing the test is
about**, which is the same line `signInTestMerchant` draws. A test asserting on the OpenAPI
description takes the one-liner; a test asserting on price *selection* names the Prices it
means, and they stay visible in the test rather than becoming a default it inherited:

```ts
await seedTestCatalog(kobai, { prices: [1250, 900] });   // two Prices on one Variant
await seedTestCatalog(kobai, { prices: [] });            // a Variant with no Price at all
await seedTestCatalog(kobai, {                           // several Variants; an unnamed one
  variants: [{ prices: [1250] }, { sku: "MUG", prices: [] }],  // takes POSTER-A2, A3, …
});
await seedTestCatalog(kobai, { merchant });              // one already signed in (ADR-0041)
```

`prices` is the one-Variant shorthand for `variants` and naming both is a type error. Ask for
a Variant by SKU — `catalog.variant("MUG").id` — never by position: a Product reports its
Variants in **SKU order**, not in the order they were asked for. `catalog.variantId` is the
first one asked for, for the common case that has only one.

**Everything it seeds is `physical`, and a test that cares says so.** A Variant's Fulfilment
Strategy decides whether it consumes stock at all (ADR-0014), so a test about that names the one
it means — and a name this deployment has not wired is refused by the route, exactly as it would
be for a Merchant:

```ts
await seedTestCatalog(kobai, { variants: [{ sku: "PDF", fulfilmentStrategy: "digital" }] });
await using kobai = await createTestKobai({          // a Plugin's, wired (ADR-0017)
  fulfilment: { strategies: { "made-to-order": madeToOrder } },
});
```

**A Cart is the arrangement every ticket in the commerce spine starts from**, and
`seedTestCart` is the one line that produces one. It seeds a catalog if it is not given one,
starts a Cart over the store surface, and puts a line on it — so the common case is one call
and the identifier is what comes back:

```ts
const cart = await seedTestCart(kobai);          // one POSTER-A2, quantity 1, for a guest

const response = await kobai.request(`/store/carts/${cart.id}`, {
  headers: cart.apiKey.headers,
});
```

**The Cart's `id` is the whole of the authority to act on it** — there is no Shopper session
to hang one off and there must never be one (ADR-0020) — so a test holds it exactly as a
storefront does. The Cart it seeds is a **guest's**, because a guest is what Core assumes
everywhere; a test whose subject is attribution asks for a Shopper, which needs a secret key:

```ts
await seedTestCart(kobai, { quantity: 3 });               // three of the one Variant
await seedTestCart(kobai, { lines: [] });                 // an empty Cart
await seedTestCart(kobai, { catalog });                   // one already seeded (ADR-0041)
await seedTestCart(kobai, {                               // several Variants, named by SKU
  catalog,
  lines: [{ sku: "POSTER-A2" }, { sku: "MUG", quantity: 2 }],
});
await seedTestCart(kobai, { shopper: { email: "…" } });   // not a guest's (ADR-0020)
await seedTestCart(kobai, { catalog, apiKey: publishable }); // a browser's key builds a Cart
```

`quantity` is the one-line shorthand for `lines` and naming both is a type error, exactly as
`prices` and `variants` are. Ask for a line by SKU — `cart.lineItem("MUG").id` — never by
position. `cart.catalog` is what the Cart was built from, so `cart.catalog.merchant` is the
session for anything the test then does on the admin surface. **Passing `catalog` is how a
test that has already signed in gets a Cart at all**, since a deployment has only ever one
first Merchant.

Two things this helper deliberately does not do. It never expires a Cart: a lifetime is
measured in days, so time is passed by winding `expires_at` back on the row, the way the
session tests do it — see the foot of `packages/core/src/cart/cart.test.ts`. And it is not
what a test about *building* a Cart should reach for; `cart.test.ts` calls the routes by hand
for the same reason a test about price selection names its own Prices.

**Everything downstream of Capture starts from a placed Order**, and `seedTestOrder` is the
one line that produces one. It seeds a Cart if it is not given one — which seeds a catalog if
*that* is not given one — and places it over the store surface, so the common case is one call
and the Order's identifier is what comes back:

```ts
const order = await seedTestOrder(kobai);      // one POSTER-A2 at 1250, placed by a guest

const response = await kobai.request(`/admin/orders/${order.id}`, {
  headers: order.catalog.merchant.headers,
});
```

**It places with a secret key, always.** The Cart's own if that key can place, so a test that
named one is placing with the key it named; the catalog's when it cannot, because placing is
where money moves and a publishable key is refused there (`403 secret-key-required`, ADR-0055)
— and that is exactly the key a browser holds. So the last line below is the storefront
pattern itself: the browser builds the Cart and the server places it. `order.apiKey` is
whichever key placed it, and reading the Order back needs that one too.

```ts
await seedTestOrder(kobai, { quantity: 2 });                  // two of the one Variant
await seedTestOrder(kobai, { catalog });                      // a catalog already seeded
await seedTestOrder(kobai, { cart });                         // a Cart already built
await seedTestOrder(kobai, {                                  // several Variants, by SKU
  catalog,
  lines: [{ sku: "POSTER-A2" }, { sku: "MUG", quantity: 2 }],
});
await seedTestOrder(kobai, { catalog, apiKey: publishable }); // a browser builds the Cart
```

Everything beside `cart` is `seedTestCart`'s own option, passed through untouched, so a Cart
this helper builds is the Cart that helper would have built — and naming `cart` alongside any
of them is a type error, exactly as `quantity` and `lines` are. Ask for a line by SKU —
`order.lineItem("MUG").total` — never by position: an Order reports its lines in **SKU
order**, not in the order they were selected. `order.cart` is what it was placed from and
`order.catalog` is what that was built from, so `order.catalog.merchant` is the session for
anything the test then does on `/admin` — the same reach `cart.catalog.merchant` is, because
an Order is read by a Merchant as a matter of course.

Three things this helper deliberately does not do. **It configures no Payment Provider** — one
belongs to the deployment rather than to a Cart (ADR-0053), `createTestKobai` already wires
`testPaymentProvider` unless the test said otherwise, and by the time a helper runs that seam
has closed; on a deployment that has none it fails naming the `no-payment-provider` refusal,
which is the honest answer. **It sends no `Idempotency-Key`**, because a test about a retry is
a test about the key and names its own. And **it is not what a test whose subject is the
placement itself should reach for**: every refusal `POST /store/orders` makes is a status this
helper never returns, and the 201 body carries an account of the Workflow run that it
deliberately drops. So `place-order.test.ts`, `idempotency.test.ts`, `payment.test.ts`, the
reference Project's `kobai.config.test.ts`, and every test in `order.test.ts` that asserts on
what placing *answered* call that route by hand — for the same reason `cart.test.ts` builds
its Carts by hand.

**The harness is promised surface** (ADR-0047): everything `@kobai/core/testing` exports is
covered by ADR-0019's semver commitment, because it ships for the Plugin author who needs the
same seam Core tests through — while the five Extension Points of ADR-0003 stay five, since
nothing attaches to a test harness at runtime. So a helper added here is designed as public
API and documented in this section, and what a helper does *internally* — which requests it
makes, in what order — is promised to nobody. `seedTestCatalog`'s, `seedTestCart`'s and
`seedTestOrder`'s own contracts, including every case above, are asserted in
`packages/core/src/testing/catalog.test.ts`, `packages/core/src/testing/cart.test.ts` and
`packages/core/src/testing/order.test.ts` against the running application rather than against
the object each returns.

**Contention has a shape, and it stays in the HTTP seam.** ADR-0018 requires check-and-consume to
be a row lock or a unique constraint and **never a `select` followed by an `update`** — and
nothing sequential can tell those apart, because the forbidden shape passes every assertion in
`reservation.test.ts`. So the test *dispatches at once*:
`packages/core/src/reservation/the-last-unit.test.ts` puts one unit on the shelf, builds a Cart
per Shopper, and fires `POST /store/orders` at all of them inside one `Promise.all`.
`packages/core/src/reservation/the-variant-that-vanished.test.ts` is the second, and the pair is
what makes this a technique rather than a special case: it dispatches six deletes and six counts
at six Variants together and holds every count to one of the two answers that are true (#145).
Four things about how they are written carry to the next one:

- **Assert on what the losers were told, and on the books, not only on the winner.** One 201, and
  every other request refused with the *reason that is true* rather than failing some other way;
  the shelf left at **zero rather than at minus something**; and **one card charged, none
  refunded**. That last one is what tells atomicity from a backstop — a hold that let everybody
  through is still caught inside Capture and the shelf still ends at zero, but by then every
  loser has been charged and refunded for a purchase that never happened.
- **A Cart each, not one Cart many times.** A Cart becomes exactly one Order, so the second shape
  is a test about *that* uniqueness rather than about scarcity, and it would pass either way.
- **How many is a named constant with its reason beside it.** Big enough that more than one
  request is inside the gap on any scheduling, small enough to stay well inside the connection
  pool — queueing behind connections serialises the very thing the test exists to overlap.
- **Each was watched failing before it was made to pass** — the first against a deliberately
  non-atomic hold, the second against the two loose statements it was written about — and what
  each run did is written down in its own file. **Write the next such test the same way round**;
  a race nobody has seen lost is not yet known to be losable. **That recorded run is the whole of
  the proof, because once the fix is in the test can no longer show the window was reached** — a
  request that landed in the gap and one that arrived after the other transaction committed now
  answer identically, which is what the fix is for, so a green run cannot tell a contended race
  from an arrangement that quietly stopped overlapping. `the-variant-that-vanished.test.ts` says
  that in as many words and it is true of both. Changing how the requests are dispatched
  therefore obliges you to watch it fail again rather than to trust that it still would.

The **migration seam** covers what HTTP cannot — that sets apply independently, into
separate tracking tables, in any order. Take a harness with `{ migrate: false }` and drive
the runner yourself:

```ts
await using kobai = await createTestKobai({ migrate: false });
await runMigrations(kobai.db, [pluginSet, coreMigrationSet]); // order is yours to choose
```

It also covers the thing every other seam here cannot: a migration meeting **rows that are
already there**. A test database is created seconds before it is migrated, so a migration
that cannot survive existing data passes everywhere in this repository and fails at the
first Project with traffic. `migrationSetUpTo` truncates a set at a named migration, which
puts the database where a real deployment is on the day the next one reaches it — apply what
had shipped, write rows through it, then apply the rest:

```ts
await using before = await migrationSetUpTo(pluginSet, "0000_creates_the_table");
await runMigrations(kobai.db, [before]);
await kobai.database.query("insert into … values (…)");

const upgrade = await runMigrations(kobai.db, [pluginSet]); // onto rows, as it will be
```

Seed **before** asserting, and say the rows are there — a widening applies cleanly to a
table that stayed empty, so the arrangement is the whole test. See ADR-0038 and
`packages/plugin-price-log/src/migrations.test.ts`.

**Never write down how many migrations a set has** (ADR-0049). Five assertions did, across
three packages, and every ticket that added a migration edited all of them — which is how a
Core migration ended up editing a Plugin's test. Ask the journal instead, and pair it with
the question the count cannot answer:

```ts
const declared = await declaredMigrations(coreMigrationSet); // by tag, in journal order
expect(declared.length).toBeGreaterThan(0);                  // two empty lists are equal
await expect(appliedMigrations(kobai.database, coreMigrationSet)).resolves.toEqual(declared);
```

**The count and the pairing are not the same assertion, and both are wanted.** A count taken
from the journal and compared against rows written from that same journal agrees with itself;
it still catches a row the set does not account for, which is Drizzle having applied
something twice (ADR-0030). `appliedMigrations` asks the database *which* of a set's
migrations it holds, matching each row by the sha256 Drizzle stores of the `.sql` — so a
migration that never ran is named rather than subtracted, and the failure reads as a missing
tag instead of `expected 9 to be 10`. A set this database has never seen is `[]`, not an
error.

What a derived count gives up is a migration deleted from the journal along with its `.sql`:
both sides shrink and nothing here disagrees. That is caught by the test that owns the
migration's **effect** — dropping `0009_updated_at_triggers` reddens `updated-at.test.ts`,
dropping a seed migration reddens `auth.test.ts` — which is also the only place that can say
what actually went missing. So **a migration whose effect no test asserts is the real gap**,
and it was never a number's job to close it.
`packages/core/src/testing/migrations.test.ts` watches the pairing fail against a database
that is deliberately one migration short, because an assertion nobody has seen fail is not
yet known to be able to.

**Never write down which migration *sets* exist either** (#129). That was the same tax one
level up: a dozen sites across six files spelled the same list four ways — a package path, a
set name, a tracking-table name, a manifest key — and adding a Plugin edited most of them.
The two answers live beside each other and are deliberately **two modules**, because they do
not have the same reach: `tests/support/wired-migration-sets.ts` reads
`reference/kobai.config.ts` with Core's set in front, exactly as `createKobai` composes it,
and `tests/support/migration-sets.ts` asks pnpm and the journals on disk and has never heard
of that config. So an **in-repo** test derives its expectation from the config; a **container
or generated-Project** test — which asserts from outside a booted image, and must not reach
into this workspace's config — goes structural through `migrationReportFindings()` instead:
no set applied nothing, and as many sets applied as the workspace ships packages that own
one. Keeping the config out of that module's import graph is what makes the boundary
something other than a comment, so **do not merge the two files back together.**

Everything derived that way inherits ADR-0049's trap, and the answer is the same shape: a set
dropped from `reference/kobai.config.ts` shrinks the expectation along with the thing it
checks. `tests/every-migration-set-is-wired.test.ts` is what cannot agree with itself — it
compares that config against the packages on disk, in both directions, and names any package
whose tables no deployment in this repository would ever create — and it has been watched
failing, both against a workspace written to offend and against the real config with a
Plugin's set taken out of it.

**Adding a Plugin to the reference Project should need no test edit, with one deliberate
exception.** `reference/src/kobai.config.test.ts` names the sets that config wires, and that
enumeration is that test's whole subject — it is the Project's test of its own config file,
the way `adaptations.ts`'s length is asserted. Extending it is the work. Anywhere else, a
list of set names is the tax coming back: check whether the enumeration is the test's actual
subject before adding to it.

**One migration test is not in-process, and that is the point.**
`tests/the-cli-and-the-migrator-agree.test.ts` shells out to the real `drizzle-kit migrate`
and then runs the programmatic migrator against the same database — CLI first, then the other
way round, with every set the reference Project wires — and asserts that each recognises the
other's work and applies nothing. ADR-0030 rests entirely on that agreement, and the two
migrators are two *implementations* with different defaults, so nothing smaller than running
both can see it.
Until #46 it was checked by hand whenever somebody remembered, which is what a drizzle bump
now arriving automatically made untenable.

**It runs in `devbox run ci` like everything else, deliberately** (ADR-0044). It adds a few
seconds to a gate that already builds images and stands up a registry, and the gate
already provides both things it needs — Postgres, and the `pnpm -r build` whose `dist` a
Plugin's `drizzle.config.ts` resolves `@kobai/core/migrations` through. A guardrail behind an
opt-in step is not a faster guardrail, it is an optional one. The one visible consequence is
that a bare `vitest` with no build ahead of it fails on this file; the failure says so and
names `devbox run build`.

The **schema seam** covers the rest of what HTTP cannot: ADR-0004's rules are properties of
the schema, not behaviours. Ask Postgres what it is holding, through `inspectSchema` from
`@kobai/core/testing` — never by hand-rolling another `information_schema` query, because
there should be one of those:

```ts
const schema = inspectSchema(kobai.database);

await expect(schema.tablesOwnedBy("price_log")).resolves.toEqual(["price_log_entry"]);
await expect(schema.foreignKeysCrossingInto("core")).resolves.toEqual([]);
await expect(schema.columnsOwnedBy("core")).resolves.toEqual(stockCoreColumns);
```

It also reads `migrationTracking()`, `columnsOf()`, `indexedColumnsOf()` and `triggersOf()`
— that last one because Core advances `updated_at` in the database rather than in TypeScript
(ADR-0037), so "does this table have the trigger" is a question about Postgres. It scans
every non-system schema rather than only `public` — the prototype's inspector reported "no
tracking tables" for exactly that reason while they sat in `drizzle` the whole time.

`foreignKeysTargeting(table)` asks the foreign-key question of **one table instead of one
package**, and it is the stronger of the two: `foreignKeysCrossingInto` excuses a package's
references to itself, which is right for ADR-0004 and wrong for the Store. ADR-0005 says the
Store is referenced by *nothing* — a `core_` table growing a `store_id` smuggles in the same
scoping key a Plugin's would, and the prefix sweep would read it as Core's own business. So
`store.test.ts` asks this one, and pairs it with a test that creates such a table and watches
the sweep name it, because an emptiness assertion nobody has ever seen fail is not yet known
to be able to. **Pass the qualified ref `tables()` hands back**, not a bare name: a bare name
resolves to `public`, and a sweep aimed at the wrong schema finds nothing and reports that
the rule holds.

The **Workflow seam** is the one place a test may reach past HTTP into a module, and it is
allowed because a declared Workflow *is* a public interface: it is one of ADR-0003's five
Extension Points, imported and read by a Project. `describe()` naming its Steps in order, and
a replacement being rejected by the compiler, are promises no response body can carry — so
`packages/core/src/workflow/workflow.test.ts` asserts them directly, including the type-level
ones, which the `typecheck` step of the gate is what actually runs. **Replacing a Step**
splits across both: that overriding rebuilds the declaration rather than aliasing it, that it
leaves the Workflow it was given alone, and that it refuses a slot the Workflow never declared
are promises about the object, so they stay there. What an override *does* is tested through
HTTP like everything else, by booting with one:

```ts
await using kobai = await createTestKobai({
  workflows: { "resolve-price": { steps: { "select-price": myStep } } },
});
```

That is the same `kobai.config.ts` shape a Developer writes, so a test of the override
mechanism is a test of the thing they actually do. **Every key of that file the harness
accepts works the same way**, `session: { idleWindowMs }` included (ADR-0050) — and a value
Core will not serve rejects the `createTestKobai` promise rather than booting, because
`createKobai` refuses it. Time is passed by winding the row back rather than by waiting; the
helpers at the foot of `auth.test.ts` are the only honest way to test a window measured in
minutes.

**Inserting a Step** sits beside `steps` rather than inside it, so replacement and
observation are distinguishable at a glance, and a list because observing composes:

```ts
workflows: {
  "resolve-price": {
    steps:  { "select-price": myStep },        // owns the slot
    after:  { "select-price": [watchIt] },     // watches it; `before` likewise
  },
}
```

An inserted Step takes and gives the **same** type — what the slot is given, before it; what
the slot produced, after it — so it cannot alter the output contract. That is enforced by the
same compiler check that rejects a bad replacement, and the `@ts-expect-error` assertions
pinning it live beside the ones for replacement. **Compensation** is a third argument to
`defineStep`; the runner unwinds the Steps that completed in reverse when a later one fails,
handing each one the very value its `run` was given. That unwinding *order*, and that the
value is the same one, are promises about the declaration and are asserted in
`workflow.test.ts` like the rest of the Workflow seam. So is what happens when a compensation
itself throws (ADR-0036): **unwinding is exhaustive** — every completed Step's compensation is
attempted, in reverse, and one that throws neither stops the ones before it nor replaces what
stopped the run. The refusal still answers with its own `reason`, a Step's bug still travels
as itself, and the compensations that threw are reported beside the outcome — as
`uncompensated` on a refused `WorkflowRun`, or as the `UnwindFailure` a travelling bug becomes
the `cause` of. Whether a compensation actually undid anything is not — ask the database, as
`packages/plugin-price-log/src/record-price-resolution.test.ts` does, and never settle for a
counter that says the callback was reached.

The **packaging seam** covers what none of those can, because it is not about a running
database at all: that the `migrations/` directory each package resolves relative to its
*built* output survives being packed, and so actually reaches a Project's `node_modules`.
`tests/packaged-migrations.test.ts` packs every workspace package that ships a
`migrations/` directory or names one in `files`, and reads the tarball back. The packages
are discovered rather than listed, so the next Plugin is covered without an edit.

The **browser seam** is the Admin's, and it is the only one that opens a browser.
`tests/the-admin-in-a-browser.test.ts` drives Chromium against a really-booted reference
Project; `tests/support/admin-browser.ts` is the harness and its header says how to add a
case. It asserts the **frame's** promises — deep-linking, refresh, back and forward, session
expiry and return, a refusal rendering where it was attempted, list, loading and empty states,
and what a Role is offered and refused (#178) — with `axe-core` on every screen and explicit
keyboard assertions beside it. It
asserts no screen behaviour: **a case a request could have asked belongs in the HTTP seam.**
[The Admin](#the-admin) has the rest of it.

The **image seam** is the last one, and its rule is: **ask the built image, never the
Dockerfile.** Both Dockerfiles ran `pnpm install --prod` in their runtime stage, which looks
exactly like the thing that drops devDependencies and is not — run over an existing
`node_modules` it rewrites the symlink farm and leaves `node_modules/.pnpm`, every
devDependency's bytes, where it was. It relinks; it does not prune, so `drizzle-kit`,
`vitest`, `biome`, `typescript`, React, Vite and Tailwind all shipped, and no reading of the
file said so (#12). Pruning therefore happens in the **build** stage, before anything is
copied out of it: a `rm -rf` after a `COPY --from` hides the bytes in a lower layer and the
image is the same size. `tests/support/container.ts` builds an image, reads inside it and
boots it; `tests/the-runtime-image.test.ts` does that to the repository's, and
`tests/a-project-boots-from-its-own-compose-file.test.ts` generates a Project and runs
`docker compose up --build` on the compose file and Dockerfile a Developer receives.
Inspecting is not enough on its own — a prune that removed something the runtime needs looks
identical to one that worked until the container is made to serve a request.

**A credential is a build secret, never a file.** A Project's `.npmrc` holds an auth token
when kobai comes from a private mirror, and a token that arrives through `COPY` is in an
image layer forever, whatever a later `rm` says. So `.dockerignore` refuses the file and the
Dockerfile mounts it — `RUN --mount=type=secret,id=npmrc,target=/app/.npmrc` — for the length
of the install and no longer. Both halves, because either alone is a trap: the ignore line
without the mount breaks every private-registry build, and the mount without it leaves the
accident possible. The Project's image test greps the built image for the token rather than
reading the Dockerfile, which is the only check that can see this.

Real Postgres rather than a fake, because under
[ADR-0004](docs/adr/0004-plugins-own-their-tables-core-tables-are-closed.md),
[ADR-0011](docs/adr/0011-postgres-and-drizzle.md) and ADR-0030 the schema and its migrations
*are* part of the product — a fake skips the thing most likely to break. Assert on response
bodies, status codes and database state; never on internal call sequences or module
structure, which Core reserves the right to change
([ADR-0019](docs/adr/0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md)).

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
| `docs/agents/` | all | Machine-facing config the engineering skills read. |

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
