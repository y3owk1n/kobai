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

Four things follow, and each has a test rather than a convention behind it:

- **What the gate lints is `.gitignore`'s question, not `biome.json`'s** (ADR-0068).
  `biome.json` sets `vcs.useIgnoreFile`, so a gitignored path is out of scope **at any
  depth** — which is what `"!.devbox"` was not: it was root-anchored, so a `devbox run`
  inside `reference/` left a nix profile manifest the gate then failed to format, naming a
  nix store path and nothing that would lead you to `reference/` (#203). `.scratch/` was the
  same bug with no ticket. So `files.includes` now excludes **only what git tracks** — the
  five generated artifacts an ignore file can never carry — and
  `tests/the-gate-lints-what-git-tracks.test.ts` fails naming any exclusion git tracks no
  file under. **An artifact directory is one edit: add it to `.gitignore`.** Adding it here
  too is the second, narrower answer that produced #203, and it now reddens the build.
  **Every `.dockerignore` obeys the same rule and cannot delegate it**, Docker having no
  `useIgnoreFile` — so a pattern naming something `.gitignore` names is written `**/`-first,
  as `**/node_modules` always was and `.devbox`, `.env` and `.env.*` were not. That one had
  no ticket and a worse consequence than a red gate: `COPY . .` put `reference/.devbox` and
  any `reference/.env` into the image, and `.gitignore` is why `git status` would never have
  shown you either. `tests/nothing-git-ignores-reaches-the-build-context.test.ts` derives it
  from `.gitignore` for all **three** copies — the template's included, which follows only
  through `devbox run template:generate`. **`.claude/worktrees/` is ignored for the same
  reason and is the sharpest case**: a harness puts a whole second checkout there, and a
  nested `biome.json` is one Biome refuses outright — so `devbox run lint` *failed*, naming
  a directory you are not in. It is also the only entry in either ignore file with an
  interior slash, so it is anchored at the root rather than matching at every depth, and the
  `.dockerignore` sweep knows the difference.
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
  ADR-0033 instead. `devbox.json` is the opposite — HuJSON, real comments welcome, `"// …"` keys
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
| `devbox run admin:dev` | The Admin with a reload loop, beside `devbox run dev`. See [The Admin](docs/agents/the-admin.md). |
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
| `packages/core/migrations` | Core's migration set. Generated, never hand-edited except for `--custom` files — see [Adding a required column](docs/agents/migrations.md#adding-a-required-column-to-a-table-that-already-exists) for the one case that needs both. |
| `packages/core/openapi.json` | The OpenAPI description. Generated, never hand-edited. |
| `packages/core/src/upgrade` | `kobai-upgrade` — the command that moves a Project across a kobai version, and the codemod set it consults (ADR-0035). |
| `packages/client` | `@kobai/client` — the typed client, generated from that description (ADR-0006). |
| `packages/plugin-price-log` | `@kobai/plugin-price-log` — a deliberately trivial Plugin. One table, one offered Step, nothing else. |
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
| `reference/Dockerfile`, `reference/compose.yaml`, `reference/devbox.json`, `reference/scripts/` | The **Project's**, generated into what a Developer receives. |
| `compose.yaml`, `Dockerfile`, `devbox.json` | The **workspace's** — what `devbox run ci` and `devbox run up` use. |

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
