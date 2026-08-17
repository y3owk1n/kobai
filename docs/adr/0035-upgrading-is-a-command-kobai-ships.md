# Upgrading is a command kobai ships, carried by the version being upgraded to

ADR-0001 has said since the beginning that upgrading kobai is "a version bump plus shipped
codemods rather than a merge", and ADR-0029 makes "the reference Project upgrades cleanly
across a Core major" a release gate. Building that gate found that **kobai shipped neither
half**. The word *codemod* appeared twice in the repository, both times in prose, in those
two ADRs. There was no codemod, no runner, no convention for where one would live — and
nothing that bumped a Project's `@kobai/*` ranges either, so even the version bump would
have had to be a script the gate wrote for itself, standing in for the first step of the
thing under test.

So `@kobai/core` now ships a bin, **`kobai-upgrade`**, and a codemod set — which is empty,
and says so.

## A runner that correctly runs nothing is a tested runner

The alternative was to write the gate around the hole and record the codemods as a v1.0
concern. Rejected: a gate that verifies everything *except* the step a Developer actually
runs is the quiet weakening ADR-0024 warns about, and it would have gone green on a commit
that broke the upgrade path, forever, because there would be no upgrade path to break.

The empty set is not a placeholder. `0.1.0` is the first version kobai published (ADR-0034)
and nothing has been broken since, so **there is nothing to migrate and the honest number is
zero**. What the gate proves is the *delivery mechanism*: that the command exists, that it is
found where a Developer would run it, that it moves the ranges, that it locates the set
belonging to the version being moved to, and that a deeply customised Project survives all
of it and still serves the price its own Step decided.

This is the same argument #2 made for running Core's own migrations through the Plugin
machinery: one implementation, exercised continuously, rather than a second one discovered to
be wrong the first time a third party needs it.

## A codemod is keyed to the version that broke something

`Codemod.introducedIn` names the version whose breaking change the codemod migrates across,
and the runner applies every codemod whose `introducedIn` falls in `(from, to]`, in version
order. That is the whole resolution mechanism, and it is settled now because it is the part
that is expensive to change later.

The alternative — a map keyed by `from → to` — is what makes upgrade tooling rot. It is
O(n²) in releases, so either every new version rewrites every older entry, or a Project
upgrading two majors at once falls through a hole nobody enumerated. Keyed by the version
that introduced the change, a Project jumping `0.1.0` to `3.0.0` runs `1.x`'s, `2.x`'s and
`3.x`'s codemods in order, and the author of each wrote it without knowing where anybody
would be upgrading from.

**A `0.x` minor counts as a major here.** `^0.1.0` means `>=0.1.0 <0.2.0`, so `0.1.0` to
`0.2.0` breaks a Project exactly as `1.x` to `2.x` does. Treating `major` alone as the
boundary would call kobai's entire pre-1.0 life one uneventful major and run nothing through
it.

## Why it lives in `@kobai/core`

Three homes were possible.

- **`create-kobai upgrade`.** Rejected twice over. It is the *create* command — a Developer
  runs `npm create kobai@latest` once and never installs it — so the version of it they
  happen to fetch has no relationship to the version of Core they are moving to. And its CLI
  path deliberately imports nothing but Node builtins, so that the published command cannot
  fail on a missing dependency; a runner is more than that.
- **A fifth package, `@kobai/upgrade`.** Rejected as a rename of nothing.
  `tests/publish-guard.test.ts` already keeps every published version in step, so
  `@kobai/upgrade@1.0.0` would be "the thing that ships with Core 1.0.0" spelled longer.
- **A bin of `@kobai/core`.** Chosen. Core is an ordinary dependency of every Project at
  exactly the version being upgraded to, once the install has run — so the set the command
  consults is, by construction, the right one, with no version negotiation anywhere.

## The bootstrap, and the cache that nearly broke it

The runner that executes is whichever Core the Project had installed when the command
started — the **old** one. The set it applies is found on disk **after** the install, so it
belongs to the new one. An old runner can therefore meet a set written to a contract it does
not understand, which is what `CODEMOD_SET_FORMAT` is for: it refuses, loudly, rather than
reporting that there were no codemods. Those are different answers.

**Three answers, and they must stay three.** *Ran these codemods*, *found none for this
boundary*, and *could not read the set at all* are different things, and collapsing the third
into the second is the failure mode. So a set that is present and wrong about itself — an
unreadable `CODEMOD_SET_FORMAT`, a codemod whose version cannot be ordered, an export that is
not an array — **fails the command**. Only a version exporting no set at all is survivable,
because the report is still worth printing: the ranges moved and the install ran. Even that
exits non-zero, because a version that intends to ship no codemods exports an empty set and
says so, and anything else means kobai shipped a broken package.

**Node's module resolver cache is a trap in exactly this place, and it was a real bug in the
first version of this command.** `require.resolve` caches by specifier and search path, so
resolving `@kobai/core` from the Project before and after the install returns the same
answer — the package from *before* it. The command reported the old version as the new one
and would have run the old version's codemods. Nothing failed, because at an empty boundary
both sets are empty; the day a real codemod shipped, the wrong one would have run and the
gate would have been green throughout. So the installed package is now found by reading
`node_modules/@kobai/core` off the filesystem, and the set is resolved from *inside* it,
where pnpm's real path carries the version and the cache key changes when the version does.
The gate asserts the report names the version arrived at, which is the assertion that catches
this class of bug at all.

## The install must be allowed to move the lockfile

The command rewrites every `@kobai/*` range and *then* installs, so at the moment the install
runs `pnpm-lock.yaml` is out of date **by construction**. That is not a state to recover
from; it is what an upgrade is. So this one install runs `pnpm install --no-frozen-lockfile`,
and the flag is part of the design rather than a workaround.

**pnpm turns `frozen-lockfile` on by default whenever `CI` is set**, which made this the
worst kind of bug: the command worked on every Developer's machine and refused to run in CI —
where an upgrade is most often run unattended, and where a failure costs the most — with
`ERR_PNPM_OUTDATED_LOCKFILE` blaming a lockfile that was stale precisely because the command
had done its job. kobai's own gate found it that way round, green locally and red in GitHub
Actions, and the fix belongs in the shipped command: setting `CI=` for the gate's child
process would have made the gate pass and left every Developer's CI broken.

The flag is scoped to this install and no other. Everywhere else a lockfile is stale by
accident and refusing is correct — a Project's Dockerfile production install, this
repository's `devbox run ci`, a Project's own `devbox run install`. The gate now sets
`CI=true` for the upgrade command it runs, so the environment that catches this is present
locally too, rather than only in GitHub Actions.

**A Developer is told.** The report's *Install* section names the flag, says
`pnpm-lock.yaml` was rewritten and why, and says to commit it beside the manifests — the
same standard the three codemod outcomes are held to, applied to a file the Developer never
named. When no range moved, it says the lockfile had nothing to re-resolve instead.

## No AST tool, deliberately, and this is where that gets revisited

A codemod is handed the Project's directory and nothing else. That is the smallest honest
contract, it needs no parser, and it is enough for everything a manifest-level migration
needs — which is all kobai has.

It is not enough to rewrite a Developer's TypeScript, and **kobai cannot currently do that
at any price it wants to pay**. TypeScript 7 ships no programmatic API (AGENTS.md § *There is
no TypeScript compiler API*), and #28 rejected pinning a second compiler alongside it.
jscodeshift, recast and babel would work and are a dependency family kobai does not have.
Choosing one for an empty set would be choosing it at the worst possible moment. When the
first codemod that needs an AST is written, that is the decision to take, and bumping
`CODEMOD_SET_FORMAT` is how an older runner is told it cannot run it.

## The synthetic major

The gate manufactures one on every commit: the packages this commit built, packed, their
manifest version and their `@kobai/*` dependency pins rewritten, republished to the local
registry ADR-0034 stands up. A rewrite of one manifest field is exactly what a real version
bump is, and the files inside the tarball are the ones `tests/packaged-migrations.test.ts`
reads. Nothing in the working tree is touched — a test that edited a manifest in place would
leave a dirty repository the moment it crashed.

The dependency pins move too, and that is not a nicety: `pnpm pack` resolves a `workspace:*`
to an exact version, so a `@kobai/plugin-price-log@1.0.0` still asking for `@kobai/core@0.1.0`
would install a **second** Core beside the new one. The Project would hold two migration
runners and two sets of Workflow declarations, and the upgrade would appear to work while the
Plugin talked to the old Core.

**What the synthetic major deliberately is not is a breaking change.** `1.0.0` is `0.1.0`'s
code under another number. So the gate proves the path a Developer walks and proves that a
deeply customised Project survives it; it does not prove that a codemod transforms anything.
That is pinned separately, against fixtures, in
`packages/core/src/upgrade/codemods.test.ts` — selection, ordering, the boundary being
exclusive of `from` and inclusive of `to`, and a format the runner cannot read being refused.
Inventing a breaking change inside the gate would be inventing the thing under test.

## Consequences

- **`@kobai/core` has two new promised surfaces**, and ADR-0019 means semver covers them:
  the `kobai-upgrade` bin, and the `./codemods` export. `./package.json` is exported too,
  which is what lets a Project be asked which version it has.
- **`devbox run ci` is slower by an install, a build and a boot.** The gate installs a
  generated Project, boots it, arranges a Store through the public API, upgrades, rebuilds,
  boots again and asks the same question. Every cheaper version proves something weaker.
- **The upgrade command assumes pnpm.** A Project pins its own (ADR-0034), so this is the
  package manager kobai knows about. There is deliberately no flag to skip the install and no
  dry run: no codemod can run until the version being moved to is on disk, so either would be
  an upgrade that quietly ran none — which is the one outcome this whole decision exists to
  make impossible. A Developer on another package manager runs the install themselves and
  then this command; if `pnpm` is not there, it fails saying so.
- **Nothing has been released, and this does not change that.** ADR-0034's separation
  between *publishable* and *published* stands: the only registry any of this reaches is the
  verdaccio a test starts and kills.
