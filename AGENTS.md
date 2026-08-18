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
are the identical command**, deliberately: a gate stricter than the command you are told to
run is a difference that shows up nowhere until CI goes red. `devbox run format` is the
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
| `devbox run ci` | **The gate.** Everything below, in order. |
| `devbox run up` | Postgres and the reference Project, on this checkout's own port — it prints the URL. `/health`, Admin at `/admin-ui`. |
| `devbox run down` | Stop them. `devbox run db:down` also drops the volume. |
| `devbox run admin:dev` | The Admin with a reload loop, beside `devbox run dev`. See [The Admin](#the-admin). |
| `devbox run db` | Just Postgres — what the test suite needs, on this checkout's own port. |
| `devbox run test` | Postgres up, build, then the whole suite. |
| `devbox run typecheck` / `lint` / `format` / `build` | One step each. |
| `devbox run db:generate` | Build, then generate a migration in every package whose schema changed — Core and each Plugin. |
| `devbox run openapi:generate` | Regenerate the OpenAPI description, then the client generated from it. |
| `devbox run template:generate` | Regenerate what `create-kobai` generates, from the reference Project. |

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
| `reference/Dockerfile`, `reference/compose.yaml`, `reference/devbox.json` | The **Project's**, generated into what a Developer receives. |
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

Two tests hold this. `packages/plugin-price-log/src/migrations.test.ts` seeds a row and then
applies the rest of the set — the only place in this repository a migration meets data —
using `migrationSetUpTo` from `@kobai/core/testing`.
`tests/migrations-are-safe-against-populated-tables.test.ts` reads every migration in the
repository for the statement itself. Core's own set is clear and stays clear that way: every
`NOT NULL` in it is inside a `CREATE TABLE`, and its only `ALTER TABLE`s add foreign keys to
tables created in the same migration.

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

`tests/`-style emptiness assertions cannot see this, so **the guardrail is a concurrent test**:
`packages/core/src/reservation/the-last-unit.test.ts` dispatches many `POST /store/orders` at one
unit of stock and asserts exactly one Order, every other request refused with
`insufficient-inventory`, and the shelf left at zero rather than at minus something. It was
watched failing against a deliberately non-atomic hold before it was made to pass — one 201 and
five 500s, every loser stopped by the guard inside Capture and refunded by a compensation that
should never have run. **Write the next such test the same way round.**

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

Three things follow, and each is a decision rather than an implementation detail:

- **A Variant may only point at a Strategy the deployment has wired.** `POST /admin/products`
  refuses `unknown-fulfilment-strategy` at 422, naming the ones it does have; `place-order`
  refuses the same reason at 409, which is only reachable by *unwiring* a Strategy Variants
  already point at. Guessing `physical` for an unknown name would claim stock nobody asked to
  claim and record an Order as shipping something that does not ship.
- **The answers are asked once per placement and carried.** `load-cart` resolves each line's
  `AppliedFulfilment`; `hold-reservations` reads `tracksInventory` off it and `capture-order`
  snapshots it. A Step that asked again could get a different answer, because a Strategy is asked
  *about a Variant* and may read its `metadata` (ADR-0013).
- **Not tracking Inventory means no claim, not a claim of zero.** The filter lives in
  `inventoryProvider.claimsFor` rather than in the Step, because deciding *which* lines are its
  business is what a provider is for — Capacity will read `hasLeadTime` there in the same place.
  A digital Variant therefore needs no Inventory row, and sells freely even if somebody counted
  it: the Strategy says whether stock is involved and the row only says how many.

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
own name; and the open context is reachable only through the **query string** today
(`openMetadata` is `Object.fromEntries(url.searchParams)`, #121), which is why its tests place
Orders at `POST /store/orders?leadTimeDays=3`. **Capacity is still out of scope** — the Strategy
says only *that* there is a Lead Time, never that a date can be met (ADR-0012).

### The API contract

**A route is a declaration, and the description is generated from it.** Core's HTTP surface
is an `OpenAPIHono` (`@hono/zod-openapi`): each route is a `createRoute({…})` object naming
its path, its security scheme, the body it takes and every status it answers with, and
`app.openapi(route, handler)` both serves it and puts it in the description. So `c.json(body,
status)` is typechecked against the schema the route declared — **a response the description
promises and the handler does not produce fails the build.** Do not add a route with a bare
`app.get(…)`; it would be served and undescribed, and `openapi.test.ts` fails when the
router's table and the description disagree.

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
nothing else here would notice. It stops at the status: the `session-*` and `api-key-*`
*reasons* inside a `401` are pinned one level down, by the mapped `satisfies` on
`SESSION_REASONS` and `API_KEY_REASONS` in `contract.ts`, which makes each declared set exactly
the rejections its gate can produce. **No route is excused.** `POST /admin/merchants` was the
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
the Admin's source and on any kobai path `openapi.json` does not carry. Interaction and
visual testing of the Admin is deferred, not forgotten; that guardrail is what stands in for
it.

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
reference Project depends on has to be published**, and in three more places than its own
manifest: `PUBLISHED_KOBAI_PACKAGES` in `packages/create-kobai/src/adaptations.ts`, so a
generated Project asks a registry for a version rather than for `workspace:*`, and the
`publishPackages` list in each acceptance test that stands a registry up
(`tests/a-generated-project-boots.test.ts`, `tests/a-project-boots-from-its-own-compose-file.test.ts`,
`tests/the-upgrade-gate.test.ts`) — a package missing from one of those fails deep inside an
install with a 404 naming the registry rather than the list. Nothing has actually been released; choosing a
release process is a separate decision.

What stands where `private: true` stood is `publishConfig.registry`, pinned at a loopback
address in every publishable manifest, and `tests/publish-guard.test.ts`. **npm resolves the
publish target from `publishConfig.registry` before it opens a connection, and that value
beats both `--registry` and `npm_config_registry`** — so a publish to npmjs.com has to be
deliberate, and CI publishes by packing a tarball and passing `--registry`, which is the one
form that honours the flag.

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
the same question. Each assertion is one clause of ADR-0001's promise and says which clause
broke, because `exit 1` at three in the morning is not a diagnosis. What it deliberately does
not prove is that a codemod transforms anything — there is no breaking change to migrate —
and that is pinned against fixtures in `packages/core/src/upgrade/codemods.test.ts`.


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
subject, and a helper would hide it; that second Merchant goes through `POST /admin/merchants`
with the seeded one's session, which is the only way there is, and `sessionOf(response)` reads
the session cookie off their sign-in response the way a browser would.

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

**One migration test is not in-process, and that is the point.**
`tests/the-cli-and-the-migrator-agree.test.ts` shells out to the real `drizzle-kit migrate`
and then runs the programmatic migrator against the same database — CLI first, then the other
way round, with Core's set and a Plugin's — and asserts that each recognises the other's work
and applies nothing. ADR-0030 rests entirely on that agreement, and the two migrators are two
*implementations* with different defaults, so nothing smaller than running both can see it.
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
