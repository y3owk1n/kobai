# kobai's packages are published, and the reference Project is what `create-kobai` generates

ADR-0001 says Core is an **ordinary versioned dependency** of a Project, and ADR-0029 makes
the reference Project the release gate. Building `create-kobai` forced both to become true
rather than intended, and neither was: every kobai package was `private: true` at `0.0.0`,
and the reference Project was a folder inside this workspace with no migrations setup, no
Dockerfile, no compose file and no `.env.example` of its own.

Two decisions, recorded together because neither works without the other.

- **`@kobai/core`, `@kobai/plugin-price-log`, `@kobai/client` and `create-kobai` are
  published packages** at a real version, starting at `0.1.0`. `private: true` is gone from
  all four.
- **The reference Project is a standalone Project tree**, and `create-kobai`'s template is
  **generated from it** and checked in. The repository root keeps its own `Dockerfile`,
  `compose.yaml`, `devbox.json` and `.env.example` for the workspace; the reference Project
  now has the Project-shaped ones a Developer receives.

## Why a local registry rather than npmjs.com

The acceptance test for scaffolding is that a generated Project boots and serves a request.
That needs Core to be installable from outside this workspace, which `workspace:*` is not.

Publishing to npmjs.com would make the dependency real and would quietly gut the test: CI
would install the **last released** Core rather than the Core in the commit under test, so
"generate a Project, boot it, serve a request" would stop saying anything about the change
being reviewed. The gate would go green on a commit that broke scaffolding, and stay green
until somebody released.

So `devbox run ci` stands up a **local registry** — verdaccio, on an ephemeral port, holding
the packages this commit built — and the generated Project resolves `"@kobai/core": "^0.1.0"`
from it. The specifier is an ordinary semver range and the resolution is ordinary registry
resolution; the only thing the test supplies that a Developer would not is one `.npmrc` line
pointing the `@kobai` scope at that registry, which is the same line anyone using a private
mirror writes. `tests/support/local-registry.ts` is the seam, and it is a module with an
interface rather than a detail inside one test file because #12's upgrade gate needs exactly
this to bump Core across a synthetic major.

Two options were rejected. A `file:` or packed-tarball dependency boots a Project today and
is **not** an ordinary versioned dependency, so it satisfies the acceptance test while
hollowing out the only claim the test exists to check. Generating inside this workspace
resolves `workspace:*` and proves nothing about a Developer's machine.

## What stands where `private: true` stood

`private: true` was the only thing between a mistyped `pnpm publish` and npmjs.com, and
removing it from four packages needs a replacement rather than a note. Each publishable
manifest pins `publishConfig.registry` at a loopback address.

This is a stronger guard than it looks, and the strength was measured rather than assumed:
npm resolves the publish target from `publishConfig.registry` **before it opens a
connection**, and that value beats both `--registry` and `npm_config_registry`. A publish
that reaches the public registry therefore has to be a deliberate act by someone who worked
around the pin, not a command run in the wrong directory. It is the same shape as ADR-0030's
argument — the primary control is that the dangerous thing is not reachable by accident — and
`tests/publish-guard.test.ts` is what keeps it in place.

It has one consequence worth knowing: CI cannot publish with a plain `pnpm publish` either.
It packs each package and publishes the **tarball** with an explicit `--registry`, which is
the one form that honours the flag.

## Why `0.1.0`

`0.0.0` on four packages is not a starting point, it is an absence — and a generated Project
pins a caret range against whatever is there, so a version nobody chose becomes a range
nobody chose. ADR-0024 gives kobai one release target covering the whole platform, so
anything with a `1` in front of it would claim something the walking skeleton has not
earned. `0.1.0` is the first honest minor, and it is the version #12 bumps across a synthetic
major.

## Why the reference Project is the source and the template is the artifact

`create-kobai` cannot read `reference/` on a Developer's machine, so the template has to ship
inside its tarball. That leaves a choice about which of the two is authored.

Authoring the template would mean the maintainers edit a Project they never boot, and carry
each change across to the one they do. Authoring the reference Project means they edit the
Project they actually run — the one ADR-0029 makes the release gate — and one command carries
it across. `devbox run template:generate` is that command, and
`tests/create-kobai-matches-the-reference-project.test.ts` fails the build when it has not
been run. This is the arrangement `packages/core/openapi.json` and
`packages/client/src/schema.ts` already have: generated, checked in, and guarded by a test
that regenerates and compares.

**The differences between the two trees are enumerated, and everything else must be
identical.** `packages/create-kobai/src/adaptations.ts` holds the list — the Project's name,
the kobai dependencies being `workspace:*` inside this repository and a semver range outside
it, two `extends` paths, one `paths` entry, and the pnpm and TypeScript versions a Project
inherits from the workspace root here and must carry itself elsewhere — plus three files a
standalone Project has and the reference Project does not. The test fails on any other
difference in either direction, including a file present in one tree and absent from the
other.

That list is the whole guarantee, so its length is asserted too. A byte comparison with no
allowances would fail the first time the reference Project legitimately said `workspace:*`;
an allowance broad enough to cover that quietly would pass forever. Keeping it short enough
to read in a review is what keeps it between those.

## Consequences

- **`devbox run ci` is slower by an install and two builds.** The acceptance test generates a
  Project, installs it from the local registry, builds it and boots it. That is the price of
  the claim; every cheaper version of the test proves something weaker.
- **The gate needs a network for the generated Project's non-kobai dependencies.** The local
  registry proxies nothing on purpose — only `@kobai/*` is asked of it — so React, Vite,
  Drizzle and the rest come from wherever npm normally looks, warmed by the pnpm store cache
  CI already keeps.
- **Nothing is released yet.** These packages are publishable and unpublished; no workflow
  publishes them and the version has never left this repository. Choosing a release process,
  and the first real `npm publish`, is a separate decision this ADR does not make.
- **A generated Project pins its own pnpm.** It has no workspace root to inherit one from,
  and the versions differ in ways that matter — pnpm 10 fails an install outright when a
  dependency has an unapproved build script.
- **`reference/Dockerfile` and `reference/compose.yaml` are generated but not exercised
  here.** The repository root's are what `devbox run up` and the test suite use. #12 builds
  and boots the image, which is where the Project-shaped ones get run.
- **The reference Project now owns tables**, in its own migration set with its own tracking
  table, so "a Project can add columns to its own tables freely" is exercised on every commit
  rather than described. A Project's set is named `project` rather than after the Project,
  because a Project is a singleton in its own database and a fixed name keeps what
  `create-kobai` generates identical to the reference Project.
