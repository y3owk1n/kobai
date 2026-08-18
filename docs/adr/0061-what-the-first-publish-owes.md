# What the first publish owes is one list, and the next obligation joins it

kobai has never published. `publishConfig.registry` is pinned at a loopback address in every
publishable manifest, npm resolves that pin *before* it opens a connection and it beats
both `--registry` and `npm_config_registry`, and `tests/publish-guard.test.ts` fails the build
if one goes missing. So the first publish is an act somebody has to take on purpose — and a
great deal has been decided on the strength of it not having been taken.

**Four records had made that bargain and none of them knew about the other three.**
[ADR-0034](./0034-kobai-is-published-and-the-reference-project-is-what-create-kobai-generates.md)
says a first release "needs a version policy, a changelog, provenance".
[ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md) licences
breaking a promised surface until the first publish, registers the breaks taken, and carries a
migration that is survivable only while the licence holds.
[ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md) puts
the HTTP surface under the same licence. `packages/core/src/http/app.ts` records that a
version bump has to regenerate the description beside it. Each is correct where it stands and
each names its own trigger, and **the trigger is the same one every time**: a single act,
taken once, by somebody doing it for the first time — who is by definition the person least
able to find four records they have never read.

There is a compounding property worth naming, because it is why this is not tidying up:
**every one of these is cheap now and unfixable immediately after.** A licence that expires
silently, a migration that refuses to apply to a database somebody kept, a published
description naming the release before it. None can be repaired without a second release, and
two of them cannot be repaired by a second release either.

So, three decisions, and the list itself is only the first of them.

- **This record is the list**, and the first publish is answerable from it alone.
- **The next obligation joins it**, under a rule stated below that keeps the argument where
  the decision is made and the entry here.
- **What can be asserted is asserted, and what cannot be is said to be.** The gate holds the
  list to its entry points and holds every entry point to naming the list. It does not, and
  will not, claim an entry has been discharged.

**Nothing here publishes anything, prepares to, or makes it easier.** No workflow, no token,
no scope claim, and the entry below that found two things missing from the publishable
manifests deliberately leaves them missing.

## The act it all falls due on

**The deliberate removal of a loopback `publishConfig.registry` pin from a publishable
manifest.** That is the single act, and it is single on purpose: ADR-0034 put the pin where
`private: true` had been precisely so that reaching a public registry could not be a typo, and
ADR-0058 then observed that the same act is what ends its licence. Everything on this list
falls due there.

`tests/publish-guard.test.ts` is what stands at that act — it fails on a missing pin, on a
version of `0.0.0`, on two publishable packages at different versions, and on any workflow
that runs a publish, names npmjs.com or reads an npm token. **A publisher meets that refusal
before they meet anything else**, so its message is where this record is named. The refusal is
not a formality to be deleted on the way past: deleting an assertion there is the act, and the
list is what has to be answered first.

## The list

Each entry says what falls due, where the argument for it lives, and — where there is one —
the question to ask before the pin comes out. **An entry is not a checkbox.** Nothing here can
be ticked by a machine; each is a decision somebody takes and records, and the two of them
that have a factual question in front of them say so and give both answers.

### The licence to break a promised surface closes

Argued in
[`docs/adr/0058-a-promised-surface-may-be-broken-until-the-first-release.md`](./0058-a-promised-surface-may-be-broken-until-the-first-release.md)
and
[`docs/adr/0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md`](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md).

ADR-0058's first rule — a promised surface may be broken outright, with no deprecation window,
no shim and no codemod, provided the break is argued where the type is and registered there —
holds only while nothing has been released. ADR-0060 puts kobai's whole HTTP surface under the
same licence: the paths, the fields, the statuses and a refusal's `reason`. **After the act,
the rule is ADR-0019's with nothing subtracted**, and under ADR-0035 a `0.x` minor is a major,
so `^0.1.0` meaning `>=0.1.0 <0.2.0` is the whole width of what a patch may not disturb.

Three things fall due, and only the first is bookkeeping.

- **Date the closure in ADR-0058.** That record's own consequence asks whoever takes the act
  to say so there, because "whether they are before that act or after it" is the one thing a
  reader hitting a compile error needs to be able to establish, and a licence that expired
  silently would be worse than no licence.
- **Check the register against its own rule.** Every break listed there owes the argument
  written where the type is; a break registered without one is a debt that becomes permanent
  at the same moment, because after the release the compile error is no longer the notice.
- **Spend the licence deliberately before it goes, or decide not to.** This is the entry's
  real value and it is the easiest to skip. Every promised surface kobai is not happy with is
  free to change today and costs a major tomorrow. The last moment to look at the five
  Extension Points and ADR-0060's tables and ask "is any of this shaped wrong?" is before the
  pin comes out, and the answer may legitimately be no.

### `0016` adds a unique index to a table that already exists

Argued here and acknowledged in
[`tests/migrations-are-safe-against-populated-tables.test.ts`](../../tests/migrations-are-safe-against-populated-tables.test.ts),
whose `ACKNOWLEDGED` entry names this record and this heading. This section moved here from
ADR-0058 unchanged in substance; that record held it because it was the one debt resting on
the licence and had nowhere else to be, and said in its own consequences that a second such
entry meant a record of its own.

`packages/core/migrations/0016_fresh_gwen_stacy.sql` is one statement:

```sql
CREATE UNIQUE INDEX "core_order_cart_idx" ON "core_order" USING btree ("cart_id");
```

`core_order` is created by `0012_careful_wallow.sql`, so the index arrives at a table that may
already hold rows — and the duplicates it would refuse are not hypothetical. `0016` shipped
with #118, which made a Cart become exactly one Order; *before* #118 a retried request placed a
second one, so a database anywhere from `0012` to `0015` can hold precisely the duplicate
`cart_id` values this index rejects. **The window opens at `0012` rather than at `0015`**,
because it opens where the table does, and every migration in between shipped under that same
pre-#118 code. Under [ADR-0030](./0030-generate-and-migrate-only-never-drizzle-kit-push.md) the
set runs against a live database at boot, so such a deployment would get no service at its next
start rather than a bad index, and the failure would land on somebody who wrote none of it.

The answer would be [ADR-0038](./0038-widening-a-populated-table-takes-three-migrations.md)'s
shape one door along: deduplicate in a `--custom` migration, then let the generated one add the
index. **It is not written, and that is the decision this entry records.** Writing it means
renumbering `0016` through the tail of Core's set — each `.sql` with its drizzle snapshot and
its journal entry — **to protect a database that does not exist**. Nothing has been published,
so nothing has ever installed kobai at a version carrying `0012` and not `0016`; the only
databases that have applied this set are this repository's own, each created seconds before it
is migrated, and whatever a maintainer has pointed `devbox run up` at. That last clause is the
whole of the risk, and it is the one thing the first publish has to check.

#### The question to ask before the first publish, and both answers

**Before the loopback pin comes out of any publishable manifest: has a database been migrated
from this checkout and *kept* — a staging environment, a demo, a long-lived local instance —
that reached `0012`, where `core_order` is created, without reaching `0016`?** Ask it at `0012`
and not at `0015`: a database left at any migration in that range may hold Orders written by the
code that placed two of them.

- **No, which is the expected answer.** Then the reason changes and the acknowledgement stays.
  Every database that can exist after the first publish is created by an installed version
  carrying `0012` and `0016` both, applies the whole run in one pass, and holds no row for the
  index to refuse — so the statement is safe for good, and the acknowledgement should say *that*
  rather than cite this record. It stops being true only if some released version cuts Core's set
  between the two, which is not a thing a release does. **What changes there is the kind and not
  only the wording** (#161): the entry records which of two judgements it is, and the reason above
  is neither of them — nothing has been deduplicated, and the debt is no longer waiting on a
  release — so retiring it means adding a kind, with the one thing that would show *that* kind
  false. The union in that file is what makes stating it unavoidable rather than optional.
- **Yes.** Then either the deduplication is owed after all, in front of `0016` and with the
  renumbering it costs — or that database is dropped and recreated, which is the same answer at a
  fraction of the price and is available for exactly as long as it holds nothing anybody needs.
  **Asking before publishing is what keeps the cheap answer on the table**, because after the
  first publish the same question has to be asked of deployments the maintainer cannot see.

**Expiring does not mean deleting the acknowledgement**, and the obvious reading is wrong in a
way worth being exact about. That check reads one migration file at a time, so a unique index on
a table *that file* did not create is named whatever else is true — the safe shape ADR-0038
prescribes produces the identical finding, because the deduplication answering it lives in a file
of its own. So the entry is a place for a reason rather than a suppression, this section is that
reason, and what the first publish calls for is a rewritten reason. Deleting the entry while
`0016` stands turns the gate red.

### A version policy, a changelog, provenance, and what `0.1.0` promises

Argued in
[`docs/adr/0034-kobai-is-published-and-the-reference-project-is-what-create-kobai-generates.md`](./0034-kobai-is-published-and-the-reference-project-is-what-create-kobai-generates.md),
which is where all four were first written down and where they stay: they are that record's
own account of the difference between being publishable and being published, and this list
carries the entry rather than the argument.

ADR-0034 names them in one sentence and settles none of them. What is worth adding here is
what each turns out to depend on, because two of them are not decisions taken alone.

- **The `@kobai` scope on npmjs.com is unclaimed**, and claiming it is a decision for whoever
  decides to release. It is also the one item on this whole list that somebody else can take
  out of kobai's hands, which is an argument for asking the question early even though nothing
  else here is urgent.
- **Provenance is not a flag.** `npm publish --provenance` signs against a public CI run and a
  `repository` field in the manifest; no manifest here has one (see the next entry), and no
  workflow publishes anything, deliberately. So "provenance" is at least three decisions —
  publish from CI, name the repository, hold a token — each of which the publish guard's
  workflow sweep currently refuses on purpose.
- **What `0.1.0` promises** is the one that cannot be deferred by shipping and deciding later,
  because a generated Project pins a caret range derived from Core's manifest
  (`packages/create-kobai/src/adaptations.ts`), so the first published version *is* the range
  every Project generated after it asks a registry for.

### The version is bumped in a commit, and the artifacts are regenerated in it

Argued in [`packages/core/src/http/app.ts`](../../packages/core/src/http/app.ts) and
demonstrated by [`tests/support/local-registry.ts`](../../tests/support/local-registry.ts).

Since #158 the description carries the version it was generated from: `info.version` is
`coreVersion()`, read out of `@kobai/core`'s manifest where the document is built, because
ADR-0060 makes the surface's version the package's. The checked-in
`packages/core/openapi.json` only moves when somebody regenerates it, so **a version bump that
is not followed by `devbox run openapi:generate` fails `openapi.test.ts` twice** — once as a
byte diff and once as an assertion naming both versions.

That holds inside this repository, on every commit, and it is exactly as strong as the
assumption that a version bump *is* a commit. **`tests/support/local-registry.ts` is the
working demonstration that it need not be**: `republishedAs` rewrites `manifest.version` while
repacking a tarball, which is how the upgrade gate manufactures its synthetic major, and the
`openapi.json` inside that tarball still names the version it was generated from. Nothing is
wrong today, because nothing asks — the upgrade gate never reads the description's version, and
every artifact this repository ships is generated from the manifest beside it.

**So it is a constraint on how kobai releases, and it is the only one on this list discovered
from the test harness rather than from a record:** the version is bumped **in a commit**, with
`devbox run openapi:generate` run in that same commit, and whatever is published is built from
that commit. A release process that bumps at publish time — `npm version` in a workflow, a
tarball rewritten on the way out, anything that edits a manifest after the last commit — ships
an `openapi.json` naming the previous release. ADR-0006 makes that file the supported path for a
Developer who does not write TypeScript, and the file on their disk carries no manifest beside
it, so a version it reports wrongly is one nothing else can correct.

It is free to honour if it is known in advance and invisible until somebody consumes the file,
which is the whole reason it is written down before there is a release process rather than
after.

### A publishable manifest names no repository, and its licence text is the packer's doing

Argued here, because no decision elsewhere qualifies it. It was found while writing this list,
which is the case the rule below calls a debt with no other home — and the first half of it was
found by *packing a tarball*, because the manifests say one thing and the artifact says another.

**No `repository` field exists in any publishable manifest.** That is what npm's
provenance signs against, and what puts a source link on a package page — so "provenance" in the
entry above is at least partly this, and neither packer invents one.

**The licence text ships, and only because pnpm puts it there.** Every publishable manifest
declares `"license": "MIT"` and none has a `LICENSE` file of its own; the only one in the
repository is the root's. Both packers were run against `packages/core` to see what that
produces, and they disagree: `pnpm pack` copies the workspace root's `LICENSE` into the tarball,
and `npm pack` in the same directory does not — its file list has `package.json` and `dist`, and
no `LICENSE` at all. The `files` array is not what decides it either way.

So the artifact is correct today **because of which tool packs it**, and nothing says so
anywhere. `tests/support/local-registry.ts`, `tests/packaged-migrations.test.ts` and
`tests/create-kobai-matches-the-reference-project.test.ts` all pack with pnpm, which is also
what ADR-0034 describes CI doing — so a first publish that reached for `npm publish` or
`npm pack` would ship packages asserting a licence in metadata and carrying none of its
text, and no test in this repository would notice, because every one of them reads a tarball
pnpm produced.

Two answers, and the decision is which: **pin the packer**, or **give each package its own
`LICENSE`** and stop depending on the question. Neither is taken here — adding files is release
preparation and this record is not a release — and both are cheap now and invisible until a
package leaves this machine, which is the shape every entry on this list has.

## Where the next obligation goes

Three clauses, and the first is ADR-0058's own admission rule generalised.

1. **The argument stays where the decision it qualifies is made.** ADR-0059's consequences
   carried one for as long as it was outstanding, and moving it here would have separated it
   from the decision it was a consequence of. A record that argues something is where the
   reasoning belongs.
2. **The entry comes here, always** — a section under "The list", naming what falls due, the
   question to ask if there is one, and the repository-relative path of every place the argument
   is made. A debt argued nowhere else is argued here, in full, and saying so is a stated case
   rather than an empty field.
3. **Every place named points back at this record**, by filename, so the reader who arrives at
   any one end reaches the whole list. That is what stops this re-fragmenting, and it is the part
   the gate holds.

**ADR-0058's section does not generalise, and the reason is worth stating.** It was headed "What
else the licence is holding up", and its admission rule was that a debt belongs there when it is
survivable only because nothing has been published. Three of the five entries above fail that
test: the version-in-a-commit rule would be true in a world where every promised surface was
frozen, and a manifest naming no repository would be true in a world with no licence to break
at all.
**What they share is the act, not the licence** — and the act is the larger frame, since a debt
resting on the licence is a debt resting on nothing having been published, which is a debt
falling due when something is. So release obligations get their own home, and ADR-0058's second
list moved into it, which is what that record's own consequence asked for the moment the list
grew past a couple of entries.

## What is asserted, and what cannot be

`tests/publish-guard.test.ts` holds three things, and #161's mechanism holds a fourth from the
other end. **All four are about the list's shape and its reachability, and none is about whether
an entry has been discharged.**

- **Every obligation has its section here.** `OUTSTANDING` in that file names each entry's
  heading verbatim, so deleting a section, or renaming one out from under the list, fails the
  gate rather than quietly shortening what a publisher reads.
- **Every section names the places its argument lives.** The same check #161 built for the
  migration acknowledgement, one door along: the record must name the file, and what the file
  *says* is prose the check does not read.
- **Every one of those places names this record.** So ADR-0034, ADR-0058, ADR-0060, `app.ts`,
  `local-registry.ts` and the migrations test each carry the filename, and a reader who arrives
  at any of them is one search away from the rest.
- **The migration acknowledgement names this record and this heading, and the gate holds the
  heading to naming the migration back** — unchanged from #161, retargeted rather than rebuilt.

**What is not asserted is an obligation nobody has listed.** A new debt argued in some record
that never gets an entry in `OUTSTANDING` is invisible here, exactly as ADR-0058's admission
rule was invisible to the check that replaced it — the gate can hold a list to being reachable
and cannot know what is missing from it. That is why the rule above is stated rather than
enforced, and why it asks for the entry in the same breath as the argument: the moment somebody
writes "this is survivable because nothing has been published", the entry is the other half of
the sentence.

**What is deliberately not asserted is that any of this has been done.** "Has a database been
migrated from this checkout and kept?" is not a question a process can ask; "is there a version
policy?" and "was the licence spent deliberately?" are judgements. A check that answered yes to
one of them would be worse than no check at all, because **a green gate reads as permission**,
and the failure this record exists for is somebody publishing without having read the list. The
one thing the gate can do at the act itself, it already does: refuse it. What changed is that the
refusal now names this list, so the publisher who deletes an assertion in that file has read what
they are agreeing to before they can get past it.

## Considered and rejected

- **Amend ADR-0034.** The obvious home: it owns "publishable is not published" and three of this
  list's entries are its own sentence. Rejected because its subject is why the packages are
  publishable and why the template is generated from the reference Project, and the section that
  mentions a first release does so to say the repository is *not* taking one. A list that grows an
  entry every time somebody spends the pre-release licence turns a settled record into a live
  document, and a later reader cannot tell which sentences were the decision and which are
  today's outstanding work. ADR-0034 keeps its decision and gains a pointer.
- **Supersede ADR-0034.** Nothing in it stops being true at the first publish. "Publishable is not
  published" becomes false; the local registry, the reference Project as the source of the
  template, the argument for `0.1.0` and the loopback pin's mechanics are all untouched.
  Superseding would retire a record that still describes the build.
- **Keep growing ADR-0058's section.** Rejected by that record itself: *"If that second list ever
  grows past a couple of entries it wants a record of its own — what the first publish falls due
  on is a different subject from what may be broken before it, and the register's own reading of
  its length depends on counting broken surfaces and nothing else."* Two of the five entries here
  are nothing to do with promised surfaces, and a register whose length is a reading of how freely
  the licence is spent stops being readable the moment unrelated debts are counted in it.
- **`RELEASING.md`, a checklist outside `docs/adr/`.** What a release process would want, and
  writing one now would be answering a question nobody has asked: a document called `RELEASING.md`
  tells somebody how to release, and whether kobai releases, from where, and by what process is a
  decision this record does not take and must not appear to. **This answers what falls due, not
  how to do it.** When the release process is decided, that document may exist, and it points here
  or absorbs this list under a record saying so.
- **GitHub issues with a `release` label.** Where work is tracked, and the wrong instrument for
  this: an obligation falling due at an act nobody has scheduled has no milestone, a label query
  cannot show whether it is complete, and an issue closed as "not planned" leaves the debt in
  force with no trace. The gate cannot hold an issue to naming a file.
- **A check that refuses the act until the list is empty.** A real option, and the honest version
  of it is what already exists: the pin assertion refuses the act unconditionally. What it cannot
  do is decide when the list is empty, because emptiness here is five judgements, and the
  machine-checkable proxy — no entries left in `OUTSTANDING` — would be satisfied by deleting
  them, which is the failure mode rather than the goal.

## Consequences

- **ADR-0058 is one thing again.** It states the rule about promised surfaces and registers the
  breaks taken under it; the second list it was carrying for want of a home has moved here, and
  its section is now a pointer. The register's length goes back to being a reading of how freely
  the licence has been spent, which is what that record wanted it to be.
- **The migration acknowledgement's `under` got narrower and its `recordedIn` moved.** It names
  this record and the one heading that argues `0016`, rather than the whole of somebody else's
  list, so the failure it produces names the debt instead of the neighbourhood. The mechanism is
  #161's, unchanged.
- **A new obligation is three edits**: a section here, a pointer in the record or file that
  argues it, and an entry in `OUTSTANDING`. For a one-line hazard that will feel like ceremony,
  and it is the price of the failure this record exists for — four correct records that were only
  findable by somebody who already knew they existed.
- **The list is expected to grow, and its length means something.** Each entry is a place where
  kobai is currently cheaper than it will ever be again. A long list is not a mess; it is a
  measure of how much is resting on nothing having been published, and the right moment to read
  it is before that stops being true.
- **Nothing here is closer to a publish than the commit before it.** No workflow, no token, no
  scope claimed, no `repository` field added, no `LICENSE` file copied into a package and no
  packer pinned. The entry that found those records them and leaves them undone on purpose.
