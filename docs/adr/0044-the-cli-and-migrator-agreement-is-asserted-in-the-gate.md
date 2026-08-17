# The CLI/migrator agreement is asserted in the gate, not behind an opt-in step

`tests/the-cli-and-the-migrator-agree.test.ts` shells out to the real `drizzle-kit migrate`
and runs the programmatic migrator against the same database, in both orders, with Core's
migration set and a Plugin's. It runs in the **ordinary `vitest run` that `devbox run ci`
performs** — not behind a separate devbox script, not behind an environment variable, and
not skipped by default.

That placement is the decision. The test itself is only the mechanical part.

## What it pins, and why it could not stay a habit

[ADR-0030](./0030-generate-and-migrate-only-never-drizzle-kit-push.md) rests on one property:
the `drizzle-kit` CLI and `drizzle-orm`'s `migrate()` must agree on which tracking table, in
which schema, they record applied migrations into. They have **different defaults and no
warning** — the CLI reads `migrations.schema` and `migrations.table` from `drizzle.config.ts`
and the programmatic migrator ignores that file entirely — so kobai sets both explicitly on
both paths, in `defineKobaiDrizzleConfig` and in `defineMigrationSet`. If they ever disagreed,
each would re-apply what the other had already run against a live database at boot.

The property was verified **by hand** in #28, under drizzle-orm 0.45.2 and drizzle-kit
0.31.5, and the evidence lived in a pull request description. Nothing in the suite asserted
it. Dependabot now raises drizzle bumps automatically and majors arrive as their own pull
requests, so the check's survival depended on a reviewer remembering it existed — the same
memory-dependence ADR-0030's no-`push` rule already replaced with
`tests/no-push-script.test.ts`.

## Why the gate, and not a step beside it

The tension is real and it points both ways. This is the heaviest kind of check in the
repository — a subprocess per package, a real database, and a build before any of it — and a
check too slow to run is a check that gets skipped. But a check *behind an opt-in step* is
not slower; it is optional, and an optional guardrail against a memory-dependent failure is
the memory-dependence with an extra file in front of it. The bump that breaks this arrives as
a pull request, and the thing that has to say no is the thing that pull request runs.

Three facts settled it:

- **"In the gate" and "on every Dependabot pull request" are the same sentence.**
  `.github/workflows/ci.yml` is one job whose one step is `devbox run ci`, so there is no
  second place a check could be added that a bump would still pass through. Anything outside
  that command runs only when somebody types it.
- **It is cheap in the terms that matter.** The file takes about **3.5 seconds** on an idle
  machine and under ten when several checkouts are building at once — against a gate that
  already builds Docker images, stands up a verdaccio registry, generates a Project and takes
  it across a synthetic major. It is not close to being the reason anybody skips `ci`.
- **The gate already pays for both of its prerequisites.** `devbox run ci` runs
  `docker compose up -d --wait db` and `pnpm -r build` before `vitest run`, so the database
  and the built `dist` the CLI resolves a Plugin's config through are already there. A
  separate step would have to arrange them again.
- **It has no separate cost to isolate.** The expensive suites it sits beside — the runtime
  image, the compose-file boot, the upgrade gate — are all in the same `vitest run` for the
  same reason. Moving this one out would be the first exception, and the argument for it
  ("it is slow") applies more strongly to three tests already inside.

### Considered and rejected

- **A `devbox run migrations:agree` script, run separately.** The honest version of "gate it"
  — and it puts the one check that guards this repository's most expensive failure mode
  outside the one command AGENTS.md tells everybody to run. It also needs an edit to
  `devbox.json`, which is a second list of commands to keep in step for no gain here.
- **A vitest tag or `describe.skipIf`, opt-in by environment variable.** Same objection,
  cheaper to write, and worse: it goes green while asserting nothing, which is the failure
  mode of every gate that has ever quietly loosened
  ([ADR-0039](./0039-the-lint-gate-fails-on-every-finding.md) is the worked example in this
  repository).
- **Nightly, or on a Dependabot label.** Attractive because the risk really is
  version-shaped. Rejected because the failure is not only version-shaped: a package added
  with a hand-written `drizzle.config.ts`, or a `migrationsSchema` dropped from a call to
  `defineMigrationSet`, produces exactly this drift with no dependency change at all. A check
  scoped to bumps would not see it, and a red build a day later lands on whoever pushed next.

## Consequences

- **A bare `vitest` without a build fails on this file**, because a Plugin's
  `drizzle.config.ts` resolves `@kobai/core/migrations` through the package's `exports` to
  `dist` — deliberately, since that is the path a Plugin author outside this repository
  takes, and the source aliases in `vitest.config.ts` do not apply to a subprocess. Both
  `devbox run ci` and `devbox run test` build first. The failure names `devbox run build`
  rather than leaving a module-resolution error to be decoded.
- **`MIGRATIONS_TABLE_STEM` is exported from `@kobai/core/migrations`.** It was already the
  repository's record of the bare `__drizzle_migrations` Drizzle falls back to, used by
  `inspectSchema` to recognise a tracking table at all; a test asserting that no such table
  exists should name it from the same place, and so should a Plugin author's.
- **Two packages are enough, and a third would not add coverage.** The property is about a
  database holding *more than one* migration set — Core plus one Plugin is that database.
  Adding every future Plugin to the list would multiply the subprocesses without changing
  what is being asserted.
- **The check's own sensitivity is asserted.** A guardrail that cannot fail is worse than
  none, so each of the three tables ADR-0030 forbids — one in the wrong schema, one under a
  name no set derives, and the bare `__drizzle_migrations` — is forced into a real database
  and the finding it produces is named. They are injected rather than provoked out of
  drizzle, because there is no supported way to make either migrator track in the wrong
  place; that is what the ADR bought.
- **This is the first test in the repository to run a `drizzle-kit` subprocess.** It invokes
  it as `pnpm --filter <package> exec drizzle-kit migrate`, which is what AGENTS.md tells a
  contributor to do and what neither Core nor any Plugin ships as a script — deliberately, so
  the CLI is a thing a Developer reaches for rather than a second boot path.
