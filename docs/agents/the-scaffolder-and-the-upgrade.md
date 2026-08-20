# The scaffolder, and the upgrade

`create-kobai` and the two trees it keeps in step, and `kobai-upgrade` and the codemods it runs. **Read this before editing anything under `reference/` or `packages/create-kobai/`, and before adding a breaking change a Project would have to be migrated across.**

Part of [`AGENTS.md`](../../AGENTS.md), which is the source of truth and says when to read this.
## The scaffolder, and the two trees it keeps in step

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
`@kobai/plugin-made-to-order`, `@kobai/plugin-stripe`, `@kobai/client` and `create-kobai` are
at `0.1.0` and are no
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
[ADR-0061](../adr/0061-what-the-first-publish-owes.md) is the one list of them — a first
publish starts by reading it, and adding to it is three edits: the section there, a pointer in
whatever argues the obligation, and an entry in `OUTSTANDING` in `tests/publish-guard.test.ts`,
which holds those two ends together. Closing
[ADR-0058](../adr/0058-a-promised-surface-may-be-broken-until-the-first-release.md)'s licence
is one entry on that list rather than the whole of it. **The gate cannot say an entry has been
discharged and deliberately does not try**: what it holds is that the list is complete and
reachable from every end, and the refusal a publisher meets in `publish-guard.test.ts` names it.

The acceptance test stands up a real registry — `tests/support/local-registry.ts`, verdaccio
on an ephemeral port, holding this commit's packages — generates a Project, installs, builds
and boots it. It is a module rather than a detail inside one test because **#12's upgrade
gate reuses it** to bump Core across a synthetic major.

**A Merchant's uploads are the one thing the generated `compose.yaml` carries and the
reference one must not** (#283). The storage Core ships writes them under the process's
working directory (ADR-0078) — `/app/kobai-media` inside the image — and the reference Project
wires no `media` storage on purpose, because that absence is what proves a Project which
configured nothing still serves its images. The gate's uploads are fixtures, so a volume there
would persist nothing but the leftovers of somebody's run; a Developer's are their catalog, so
losing them at the first redeploy is data loss. Hence a named volume in the **adaptation**
rather than a line in `reference/compose.yaml`. **The `Dockerfile` half of it is not an
adaptation and must not become one**: `COPY` leaves `/app` owned by root while the container
runs as `node`, so the first upload failed with `EACCES` and there was never anything to
persist — and a *fresh named volume is populated from the image's own directory, ownership
included*, so mounting one over a path the image does not carry gets a root-owned directory
and the same refusal. Creating and chowning it is correct for a Project whether or not a
volume is mounted there, so it is in `reference/Dockerfile` — shared by both trees, and needing
no adaptation. **Reading the YAML would have passed while the fix did not work**, which is why
the assertion is an upload, a `docker compose up --force-recreate app` and a read-back in
`tests/a-project-boots-from-its-own-compose-file.test.ts`. The **workspace's** own image is a
third Dockerfile and is not covered by any of this; #283 left it alone deliberately, and it has
the same root-owned working directory.

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

## Upgrading a Project, and the codemods that do not exist yet

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


