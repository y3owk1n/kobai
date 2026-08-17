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

| Command | What it does |
| --- | --- |
| `devbox run ci` | **The gate.** Everything below, in order. |
| `devbox run up` | Postgres and the reference Project. `http://localhost:3000/health`. |
| `devbox run down` | Stop them. `devbox run db:down` also drops the volume. |
| `devbox run db` | Just Postgres — what the test suite needs. |
| `devbox run test` | Postgres up, build, then the whole suite. |
| `devbox run typecheck` / `lint` / `format` / `build` | One step each. |
| `devbox run db:generate` | Build, then generate a migration in every package whose schema changed — Core and each Plugin. |
| `devbox run openapi:generate` | Regenerate the OpenAPI description, then the client generated from it. |

There is deliberately **no `push` script** anywhere — not in Core, not in a Plugin, not in
the reference Project. `drizzle-kit push` diffs against the live database and silently drops
the tables of every package whose schema it was not given, leaving their tracking rows
behind so the migration runner cannot repair it. See
[ADR-0030](docs/adr/0030-generate-and-migrate-only-never-drizzle-kit-push.md). An
explanation sits where the command would have been — a **real comment** in `devbox.json`, a
`"// …"` **key** in each package's `package.json` — and `tests/no-push-script.test.ts` fails
the build if a push script appears in either, or in a `run:` step under
`.github/workflows/`, where no script name would give it away.

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

Dependabot is configured by [`.github/dependabot.yml`](.github/dependabot.yml), which
carries the reasoning in full. Three parts of it are durable enough to belong here:

- **Weekly, on Monday** — not daily. A merged bump rewrites `pnpm-lock.yaml` and every
  open branch has to rebase onto it, so updates arrive as one predictable batch.
- **Majors are never grouped.** Minor and patch updates batch into one PR per ecosystem;
  a major matches no group and so arrives as its own PR, named for the package and the
  boundary it crosses. It is not allowed to hide inside a batch — that is the failure
  the config was written against.
- **`@types/node` is held at the major `devbox.json` provides.** Typing against a newer
  Node than the one that runs means typechecking against functions that do not exist at
  runtime. The Node pin is recorded in ADR-0031; when it moves, lift the `ignore`.

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
| `packages/core/migrations` | Core's migration set. Generated, never hand-edited except for `--custom` files. |
| `packages/core/openapi.json` | The OpenAPI description. Generated, never hand-edited. |
| `packages/client` | `@kobai/client` — the typed client, generated from that description (ADR-0006). |
| `packages/plugin-price-log` | `@kobai/plugin-price-log` — a deliberately trivial Plugin. One table, one offered Step, nothing else. |
| `reference/` | The **reference Project** — kobai's own Project and its release gate (ADR-0029). |
| `reference/kobai.config.ts` | The one file listing everything this Project has customised. |
| `compose.yaml`, `Dockerfile` | Postgres and the application, and nothing else. |

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

**Drift fails the build, in two places.** `packages/core/openapi.json` and
`packages/client/src/schema.ts` are both generated and both checked in.
`packages/core/src/http/openapi.test.ts` regenerates the description and compares;
`packages/client/src/schema.test.ts` regenerates the client and compares. Both run under
`devbox run ci`. Regenerate with `devbox run openapi:generate` — Core first, then the client,
because pnpm walks the workspace in dependency order.

**The description is not served.** `/store` refuses an unauthenticated request *before*
saying whether a path exists, and an endpoint handing out the whole surface anonymously would
undo that. A Developer reads it from the package (`@kobai/core/openapi.json`); a TypeScript
one installs `@kobai/client`.

`openapi-typescript` is pinned to **6.7.6, exactly**, and `.github/dependabot.yml` holds the
major back. Version 7 builds its output with the TypeScript compiler API and TypeScript 7
ships none — see below.

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

The **admin surface is closed by default**: `/admin/*` sits behind a Merchant session, and
each route names the one permission its Role must hold. `signInTestMerchant` creates the
deployment's first Merchant and signs them in through the public API, which is what anything
behind the gate needs before it can assert on the thing it actually cares about. A test about
*not* holding a permission should create a narrower Role itself — that is the subject, and a
helper would hide it.

The **store surface is closed by default too, behind a different gate**: `/store/*` sits
behind an API key rather than a Merchant session (ADR-0020), so neither credential is worth
anything on the other surface. `createTestApiKey` mints one through the public API, which
means a Merchant has to be signed in first:

```ts
const merchant = await signInTestMerchant(kobai);
const key = await createTestApiKey(kobai, merchant); // secret unless you ask otherwise
const price = await kobai.request("/store/variants/…/price", { headers: key.headers });
```

A test whose subject is the *kind* of key should ask for the kind it means
(`{ kind: "publishable" }`) and say why, rather than leaning on the default.

The **migration seam** covers what HTTP cannot — that sets apply independently, into
separate tracking tables, in any order. Take a harness with `{ migrate: false }` and drive
the runner yourself:

```ts
await using kobai = await createTestKobai({ migrate: false });
await runMigrations(kobai.db, [pluginSet, coreMigrationSet]); // order is yours to choose
```

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

It also reads `migrationTracking()`, `columnsOf()` and `indexedColumnsOf()`, and it scans
every non-system schema rather than only `public` — the prototype's inspector reported "no
tracking tables" for exactly that reason while they sat in `drizzle` the whole time.

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
mechanism is a test of the thing they actually do.

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
handing each one the very value its `run` was given. Test it the way
`packages/plugin-price-log/src/record-price-resolution.test.ts` does — by asking the database
whether the row is still there, never by counting calls.

The **packaging seam** covers what none of those can, because it is not about a running
database at all: that the `migrations/` directory each package resolves relative to its
*built* output survives being packed, and so actually reaches a Project's `node_modules`.
`tests/packaged-migrations.test.ts` packs every workspace package that ships a
`migrations/` directory or names one in `files`, and reads the tarball back. The packages
are discovered rather than listed, so the next Plugin is covered without an edit.

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
