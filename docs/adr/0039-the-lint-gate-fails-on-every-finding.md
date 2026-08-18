# The lint gate fails on every finding, and `biome.json` says so out loud

`devbox run lint` and the lint step of `devbox run ci` run the **same invocation** —
`pnpm exec biome ci . --error-on-warnings` — and `biome.json` lifts every recommended rule
Biome reports at `info` up to `warn`. Together those mean **nothing Biome reports passes the
gate**, at any severity. `tests/the-lint-gate-fails-below-error.test.ts` keeps it that way.

This is an ADR rather than a one-line flag because the question it answers is what "green"
guarantees ([ADR-0031](./0031-the-runtime-shape-devbox-a-pnpm-workspace-hono-and-one-gate.md)),
and because the obvious fix is only half of one.

## What went wrong

Biome 2 re-tiered its default severities: most `style` and `complexity` rules dropped to
`info`, most `suspicious` rules and the whole `noUnused*` family to `warn`. **`biome ci`
exits zero on both.** Under Biome 1 several of those were errors and failed the build. So
the 1 → 2 upgrade in #28 loosened the gate with nobody deciding to, and it was invisible
because the loosening does not announce itself: findings are still *printed*, so a run looks
identical to one that has nothing to say.

It was not hypothetical for long. Three unused-code findings from #75 sat on `main` — an
unused `PUBLISH_TIMEOUT` in `tests/support/local-registry.ts` and two unused imports in
`packages/core/src/upgrade/upgrade.test.ts` — reported on every single run, failing nothing,
for as long as it took three separate agents to notice them independently. That is the whole
argument against a tier the gate tolerates: it is where findings go to be read by nobody.

## Why the floor is every finding, not `warn` and above

`--error-on-warnings` is the obvious move and it is **not sufficient**, which is the fact
that shaped this decision. It fails on `warn` and above and ignores `info` entirely; there is
no `--error-on-info`, and `--diagnostic-level` only decides what is *printed*. Verified
directly: a lone `useTemplate` violation exits **zero** under `biome ci --error-on-warnings`.

Twenty-eight recommended rules sit at `info` in Biome 2.5.8 — the `noUseless*` family,
`useLiteralKeys`, `useIndexOf`, `useTemplate` and their neighbours. Leaving them below the
floor would leave the gate exactly as lax as the day this was filed, for a fifth of the
recommended set, while looking fixed.

So the floor is **`warn`, and nothing may sit below it**. Two mechanisms, each covering what
the other cannot:

- **The flag** covers the ~90 recommended rules that default to `warn`, and keeps covering
  rules Biome adds at that tier later, because it names no rules.
- **`biome.json`** lifts the 28 `info` rules to `warn`. No flag can do this.

They are promoted to `warn` rather than to `error` on purpose. One floor and one mechanism
acting on it is a story a reader can hold; a mix of "errors that fail" and "warnings that
also fail" invites the conclusion that some warning somewhere is survivable.

## Why not promote whole groups

Biome accepts a severity on a whole group — `"style": "error"`. It means *enable every rule
in the group*, not *promote the ones already on*. Measured on this repository: **1286 errors**,
from opinionated rules nobody opted into (`noMagicNumbers` at 247, `useBlockStatements` at
144, `noTernary` at 112). That is a different decision wearing this one's clothes, and it is
not taken here.

Enumerating all ~120 below-error recommended rules instead was rejected for the opposite
reason: it is 120 lines that a Biome upgrade silently invalidates, and it would not cover a
rule added later at all.

## Why `lint` and `ci` are the same command

A gate stricter than the command a Developer is told to run is this same bug at a new seam:
`devbox run lint` passes, the pull request goes red, and the difference is written down
nowhere either place would show it. **`devbox run format` is where leniency belongs** — it
rewrites rather than reports, so it is where a finding gets fixed instead of tolerated.

Since #133 the `lint` script opens with `sh scripts/require-install.sh lint &&`, which says
what has to be true before biome can run at all rather than changing what biome is asked to
do; `ci` carries no such guard because it opens with the install itself. So what the test
holds identical is the **biome invocation**, and it still holds it exactly.

## Why a test, and not just a config

The failure this ADR is written against is *a tool changing its defaults underneath a gate
nobody re-checked*. A configuration cannot notice that happening — a hand-kept list of
Biome's defaults is a second copy of them, and the first copy is what went stale.

So `tests/the-lint-gate-fails-below-error.test.ts` asks **Biome** for every rule's default
severity, at gate time, and fails if any rule the configuration enables resolves below the
floor. A Biome release that demotes a rule, or ships a new recommended one at `info`, turns
the build red naming the rule — instead of quietly widening what passes. It also lints two
throwaway fixtures with the flags read out of `devbox.json` itself, so deleting
`--error-on-warnings` there fails the suite rather than silently un-deciding this.

## Two JSON files in this repository, opposite comment rules

**`biome.json` cannot carry a comment.** Not a lint failure — Biome stops parsing its own
config, walks *up* to the parent checkout's, and fails with "found a nested root
configuration" naming a different directory. That is why this reasoning is here and not
beside the settings, and why the same constraint already sent
[ADR-0033](./0033-the-admins-shape-a-vendored-vite-spa-at-a-path.md)'s one exclusion here.

**`devbox.json` is HuJSON and takes real comments**, which is where the `--error-on-warnings`
explanation sits, next to the script that carries it. It must never use a `"// …"` *key* —
devbox turns every key into a runnable script
([ADR-0030](./0030-generate-and-migrate-only-never-drizzle-kit-push.md)).

## `devbox add` reformats `devbox.json`, and the parser has to expect it

`devbox add` preserves comments and **rewrites the file into trailing-comma style**.
`biome.json` allowed comments and not trailing commas, so the first `devbox add` left
`devbox run lint` failing on a **parse** error — and `devbox run format` could not repair it,
because it cannot format a file it cannot parse. Reproduced here with `devbox add jq`: seven
parse errors, and `check --write` refusing with "Code formatting aborted due to parsing
errors".

The relaxation is **scoped to devbox manifests** — an `overrides` entry matching
`**/devbox.json` — rather than applied repo-wide, because a trailing comma in `package.json`
is a real defect (npm requires strict JSON) and there is no reason to stop catching it in
order to fix a different file. The glob matches two files today, the workspace's and the
reference Project's, and both have the hazard: `reference/devbox.json` carries 36 real
comments and a Developer runs `devbox add` there too. A bare `devbox.json` pattern reached
only the first, which is a scoping mistake rather than a scoping decision.
With the override the same `devbox add` leaves an ordinary **formatting** difference, which
`devbox run format` repairs; the round trip lands byte-for-byte back on what was checked in,
comments intact.

`vitest.config.ts` parses `tsconfig.base.json` with `allowTrailingComma` and explains that it
is deliberately laxer than `biome.json`. That is still true — the override reaches
`devbox.json` alone — and the comment now says which file it is laxer *about*.

## The Tailwind exclusion was obsolete

[ADR-0033](./0033-the-admins-shape-a-vendored-vite-spa-at-a-path.md) excluded
`reference/admin/src/index.css` because `@theme`, `@custom-variant` and `@apply` were syntax
errors to Biome's CSS parser. **Biome 2.5.8 has an option for exactly this** —
`css.parser.tailwindDirectives` — and its own error message now names it. The exclusion is
removed and the option set: the file lints and formats like everything else, and 130 lines of
the Admin's stylesheet stop being unchecked.

Worth noticing that this was the same failure as the one above, sitting in the same file: a
workaround correct against one version of a tool, carried across an upgrade nobody re-examined
it during. The exclusion for `packages/create-kobai/template` stays — that one is about a
generated artifact whose bytes are compared, not about a parser.

## Consequences

- **The gate fails on findings it used to print.** That is the point, and the three findings
  on `main` were fixed in the same change so the first run after it is green.
- **`biome explain` is on the gate's critical path**, through the drift guard — about 500
  process spawns, ~10 seconds. If Biome changes that output format the test fails loudly and
  says so; that is the intended failure, not something to route around.
- **A new rule below the floor is a decision, not a chore.** The drift guard names it and
  offers two answers: promote it to `warn`, or turn it `off` deliberately. Both are recorded
  in `biome.json`; neither can happen by inattention.
