# A promised surface may be broken until the first release, and a compile error is the notice

#117 (PR #136) widened `TaxedLines.adjustments` from `readonly Adjustment[]` to `readonly
TaxedAdjustment[]`, so that a replaced `calculate-tax` is compelled to state a tax for every
Adjustment on the Order. `TaxedLines` is what a Step filling that slot returns, and Workflow
Step override is Extension Point 2 — the flagship of
[ADR-0003](./0003-the-extension-surface-and-what-we-promise.md), the one
[ADR-0019](./0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md)
puts under semver and [`docs/extension-points.md`](../extension-points.md) tells a Developer
to lean their whole weight on. **A Project that had replaced `calculate-tax` no longer
compiles, and no codemod ships.**

The change itself is settled and this is not a re-litigation. What was missing is the record:
two rules were relied on without ever being stated, and this ADR states both.

- **Before the first published release, a promised surface may be broken outright** — no
  deprecation window, no compatibility shim, no codemod — provided the break is argued where
  the type is and recorded here. The licence is that nothing is released, and it closes at the
  first publish.
- **A break the Project's own compiler catches is not codemod territory.** The compile error
  is the migration notice; what it cannot carry is the argument, and leaving that in writing is
  the obligation the rule comes with.

## What actually broke, and how far

One thing: a Step that **builds** the `adjustments` field of a `TaxedLines`. That is a replaced
`calculate-tax`, which is the slot the type is produced at. The Step that was correct the day
before #136 merged now fails to build:

```
error TS2322: Type 'readonly Adjustment[]' is not assignable to type 'readonly TaxedAdjustment[]'.
  Property 'tax' is missing in type 'Adjustment' but required in type '{ readonly tax: number; }'.
```

Everything else held, and each is worth naming so the blast radius is legible rather than
assumed:

- **The Steps downstream carry the field rather than build it.** `hold-reservations` returns a
  `ReservedLines`, which *is* a `TaxedLines` with the claims added, and `take-payment` a
  `PaidOrder` on top of that — so a replacement of either spreads its input and is untouched. One
  that rebuilt `adjustments` from an untaxed `Adjustment[]` breaks for the same reason and takes
  the same fix — as does an inserted `before` or `after` Step that rebuilds rather than passes
  the value through.
- **The HTTP contract did not break.** `OrderAdjustment` still exists; `OrderLevelAdjustment`
  extends it and is what `Order.adjustments` now refers to. A generated client gains a field
  and loses none, which is additive in the direction that matters —
  [ADR-0056](./0056-a-payment-records-whether-the-money-arrived.md)'s `received` is the same
  shape of growth.
- **No deployment has data to repair.** `core_order_adjustment.tax` arrives `not null default
  0`, which is [ADR-0038](./0038-widening-a-populated-table-takes-three-migrations.md)'s own
  first case rather than its three-step dance: zero is right for future rows as well as past
  ones, because no Step could have taxed an Order-level Adjustment before there was a column
  to put the figure in.
- **Nothing in this repository broke.** The reference Project replaces `select-price` and hands
  `apply-adjustments` to `@kobai/plugin-made-to-order`'s Step — which attaches a Lead Time
  surcharge to the **Order**, so it is exactly the case this column exists for — but it leaves
  `calculate-tax` to Core, and Core's answers zero. So the gate of
  [ADR-0029](./0029-the-reference-project-is-the-release-gate-and-content-is-built-first.md)
  stayed green throughout, which is precisely why the break needed writing down instead of being
  obvious.

## Why the tax goes on each Adjustment

The argument in full is the doc comment on `core_order_adjustment.tax` in
`packages/core/src/db/schema.ts`, where somebody about to add a figure will read it. What
belongs here is why the break could not have been a smaller change.

A delivery surcharge is [ADR-0022](./0022-shapes-modelled-now-features-built-later.md)'s own
example of an Adjustment belonging to no line, and it is taxable in most jurisdictions. Nothing
in the shape could hold that number — `core_order_line_item.tax` is on a line, and this
Adjustment is on none — so a Project wiring a real tax engine would have charged the goods' tax
and none of the carriage's, silently. The rival was one tax figure beside the Order's total,
and it loses twice: a real engine — Avalara, TaxJar, Stripe Tax — answers per taxable item with
carriage among them, so per-Adjustment tax is what it *already has in hand*; and a receipt shows
tax against the thing that bore it, as does a Return refunding one surcharge, neither of which a
lump sum can answer. **The parts are not recoverable from a total; a total always is from the
parts.**

**And it could not wait.** [ADR-0009](./0009-cart-and-order-are-separate-and-orders-snapshot.md)
makes an Order a snapshot, on the argument that a snapshot gaining a field later changes what
every Order written before it means. An Order placed without this figure is not an Order whose
carriage was untaxed; it is one that has no answer. Settling the shape before real Orders exist
is the only moment it costs a compile error rather than a hole in the books.

## The rule before the first release

Nothing kobai builds has been published.
[ADR-0034](./0034-kobai-is-published-and-the-reference-project-is-what-create-kobai-generates.md)
separates *publishable* from *published*, and every publishable manifest pins
`publishConfig.registry` at a loopback address, which npm resolves before it opens a connection
and which beats both `--registry` and `npm_config_registry`. So the only registry any of this
has reached is the verdaccio a test starts and kills.

**That is the licence, and it is the whole of it.** While it holds, a break to one of the five
Extension Points costs a Developer nothing, because there is no Developer: there is no version
of kobai anybody could have installed and therefore no Project that could have been broken. A
deprecation window would be a window over an empty room, and a compatibility shim would be a
second shape of `TaxedLines` kept alive for nobody, which Core would then have to carry past
1.0 or break twice.

**It is not permission to be careless.** Any break taken under the licence is one kobai will
not be able to take afterwards, so taking it now is the cheap version of a decision that only
gets more expensive — and two things are still owed each time: the argument written where the
type is, and the break recorded here.

**After the first release, the rule is ADR-0019's, with nothing subtracted.** A break to one of
the five is a major version bump — and under
[ADR-0035](./0035-upgrading-is-a-command-kobai-ships.md) a `0.x` minor counts as one, since
`^0.1.0` means `>=0.1.0 <0.2.0` — and it carries either a codemod keyed to the version that
broke it, or a written statement of why no codemod is possible, which the next section is the
first instance of.

**A licence that expired silently would be worse than no licence, and this one cannot.**
"Nothing is released" will stop being true exactly once, and the question is whether anybody
notices. Publishing to a public registry requires defeating the loopback pin deliberately — CI
packs a tarball and passes `--registry`, which is the one form that honours the flag — and
`tests/publish-guard.test.ts` fails the build if the pin goes missing. So the licence closes at
an act somebody has to take on purpose, and **the release that takes it closes this record's
first rule with it**. That is the one thing a reader hitting a compile error needs to be able to
date: whether they are before that act or after it.

## Whether this should have carried a codemod

**No.** ADR-0035 keys a codemod to the version that broke something, and this broke something,
so the question is real. There are two answers and only the second decides it — because the
first stops being a reason the day kobai adopts an AST tool, and the rule has to survive that.

- **A codemod could not have written this.** ADR-0035 hands a codemod the Project's directory
  and `node:fs`, deliberately, because TypeScript 7 ships no programmatic API and #28 rejected
  pinning a second compiler beside it. Rewriting a Project's tax Step is a TypeScript edit and
  kobai cannot make one at any price it currently wants to pay.
- **Even with an AST tool it should not.** The only edit a machine could make here is
  `input.adjustments.map((a) => ({ ...a, tax: 0 }))`. That compiles, and it is wrong in exactly
  the way this change exists to prevent: a delivery surcharge silently untaxed, in a Project
  that had gone to the trouble of wiring a tax engine. A codemod that turned the build green by
  charging no tax on the carriage would have undone the change under the Developer, without
  them ever reading the argument for it. **What tax the carriage bears is a question only the
  Project can answer**, and a compile error is the correct way to ask an unanswerable one.

So the line, stated as a rule: **a break the Project's own compiler catches is announced by the
compiler; a break it cannot see is codemod territory.** The second class is what ADR-0035's
`node:fs` contract already covers and is good at — a renamed configuration key, a moved file, a
manifest range — because nothing types those and a Project's build stays green while meaning
something else. The first class needs no runner: the error fires at the Project's own build,
before anything deploys, names the file and the line and the property, and cannot be skipped,
suppressed by a flag, or run against the wrong version. `kobai-upgrade` moves the ranges and
installs; the compiler speaks immediately afterwards, where the Developer already is.

**The obligation that comes with the rule is the part that is easy to drop.** A compile error
says a property is missing. It does not say the property was never there before, when it
arrived, or on what argument — which is the whole of what a reader needs. So a type-level break taken
under this rule owes a written trail the error can be searched against: the doc comment on the
type, carrying the ticket number, and this record, linked from the section of
`docs/extension-points.md` that told the Developer the signature could be leaned on. #117 has
all three, and that is what makes "the compiler is the notice" an answer rather than an excuse.

**This does not change if kobai ever adopts an AST codemod tool.** ADR-0035 leaves that decision
open for the first codemod that needs one; the argument above is about what a codemod is *for*,
not about what it can reach.

## What a Project that replaced `calculate-tax` must do

The compiler names the file and the property. The Step returns a `TaxedLines`, and its
`adjustments` field is now `readonly TaxedAdjustment[]` — an `Adjustment` with a `tax` in signed
minor units, signed with the Adjustment, so a taxed discount reduces the tax it is on.

```ts
export const myTax = defineStep(
  "my-tax",
  (input: AdjustedLines): TaxedLines => ({
    cart: input.cart,
    lines: input.lines.map((line) => ({ ...line, tax: taxOnLine(line) })),
    // Was `adjustments: input.adjustments`, which is the line the compiler is refusing.
    adjustments: input.adjustments.map((one) => ({ ...one, tax: taxOnAdjustment(one) })),
  }),
);
```

Four things about that edit:

1. **`tax: 0` compiles, and it is a decision rather than a formality.** It is what Core's own
   Step answers and it is right for a deployment that genuinely taxes nothing at the Order
   level. It is wrong for a delivery surcharge in most jurisdictions, which is the case the
   field exists for. Write the figure the Project means.
2. **A line's Adjustments are untouched, and must stay untouched.** `calculate-tax` taxes the
   *adjusted* line, so their tax is already inside that line's own `tax`; a second figure would
   be charged twice or dropped. `AdjustedLine.adjustments` therefore has no `tax` to set, and
   the `core_order_adjustment_line_level_is_untaxed` check constraint refuses one on the row.
3. **Nothing else in the Project moves.** No migration to write, no rows to repair, no client
   change — regenerate `@kobai/client` to see the new field, or do not, and nothing breaks.
4. **The Order's total accounts for it.** `total` is every Line Item's total plus each of the
   Order's own Adjustments *and the tax on each of them*, computed by one expression read by
   both the Step that charges and the Step that writes. A tax stated here is money the Shopper
   is charged.

## The register of breaks taken under this licence

The rule above says a break is owed two things: **the argument written where the type is, and
the break recorded here.** This is *here* — the list every subsequent break appends a paragraph
to, so that a reader hitting a compile error can date it against the licence rather than guess.
It is deliberately a list rather than a section per break: what a reader needs is the whole set
at a glance, and if it ever grows long enough to be unreadable that is itself a finding about how
freely the licence is being spent.

- **#117 — `TaxedLines.adjustments` widened to `readonly TaxedAdjustment[]`.** Extension Point 2,
  a replaced `calculate-tax`. The whole of this record above is that break; the argument lives on
  `core_order_adjustment.tax` in `packages/core/src/db/schema.ts`.
- **#127 — `Logger`, `ReservationProvider` and `Codemod.apply` moved from method syntax to
  function-valued properties.** Extension Point 3, dependency substitution. TypeScript checks
  method parameters *bivariantly*, so a Project's logger could declare `info: (message, fields: {
  requestId: string })`, compile, and read `.requestId` off `undefined` the moment Core called
  `logger.info("listening")` with no fields — the check `PaymentProvider` and `FulfilmentStrategy`
  had already been spelled to make. The argument is the doc comment on `Logger` in
  `packages/core/src/config.ts`. **This one is a tightening rather than a widening, and the blast
  radius is correspondingly small**: every logger that accepted what Core actually sends still
  compiles, and the two shapes that stop — `fields` declared required, and `fields` declared
  narrower than `Record<string, unknown>` — were each being handed `undefined` at runtime already.

  **Only `Logger` needed the licence, and the other two are recorded here anyway.** `Logger` is
  exported from `@kobai/core` and a Project passes one to `createKobai` today, so it is the one a
  reader could actually hit a compile error on. `ReservationProvider` is exported from nothing and
  no config key takes one; `Codemod` *is* exported, at `@kobai/core/codemods`, but the runner
  reads only the set the installed Core ships and that set has been empty in every version there
  has ever been — so nothing outside this repository can have declared either. They are in the
  register regardless, because a register that listed only the breaks somebody judged
  consequential would be a worse instrument than one that lists them all: the reader arrives
  holding an error, not a judgement. Both moved so that **every interface kobai asks somebody else
  to implement now spells its operations the same way**, which is the property that stops the next
  one being copied from whichever file was opened first.

  Pinned by `@ts-expect-error` in `packages/core/src/config.test.ts`,
  `packages/core/src/reservation/reservation.test.ts` and
  `packages/core/src/upgrade/codemods.test.ts`, which the gate's `typecheck` step runs. Each was
  watched failing against the method spelling — `TS2578: Unused '@ts-expect-error' directive` —
  before the change it pins was made.

## What else the licence is holding up

The licence is spent on more than promised surfaces. **Anything in this repository that is
survivable only because nothing has been published falls due at the same act** — the deliberate
removal of the loopback pin — and that act happens once, so the debts belong where whoever takes
it will already be reading. This section is that place, and it is deliberately *not* the register
above: the register dates breaks a Developer's own compiler announces, so that a reader holding an
error can place it. What lands here is the opposite kind, a hazard no compiler anywhere will say a
word about.

**A debt recorded where the decision it qualifies lives stays there.**
[ADR-0059](./0059-catalog-deletion-refuses-rather-than-cascading-or-releasing.md)'s consequences
carry one — two refusal reasons promised in prose and nowhere else, which this licence permits
changing outright until the first publish — and moving it here would separate it from the decision
it is a consequence of. What belongs here is a debt with **no such home**: something no record
argues, whose only trace was a constant in a test file.

### `0016` adds a unique index to a table that already exists

`packages/core/migrations/0016_fresh_gwen_stacy.sql` is one statement:

```sql
CREATE UNIQUE INDEX "core_order_cart_idx" ON "core_order" USING btree ("cart_id");
```

`core_order` is created by `0012_careful_wallow.sql`, so the index arrives at a table that may
already hold rows — and the duplicates it would refuse are not hypothetical. `0016` shipped with
#118, which made a Cart become exactly one Order; *before* #118 a retried request placed a second
one, so a database anywhere from `0012` to `0015` can hold precisely the duplicate `cart_id`
values this index rejects. **The window opens at `0012` rather than at `0015`**, because it opens
where the table does, and every migration in between shipped under that same pre-#118 code. Under
[ADR-0030](./0030-generate-and-migrate-only-never-drizzle-kit-push.md) the set runs against a live
database at boot, so such a deployment would get no service at its next start rather than a bad
index, and the failure would land on somebody who wrote none of it.

The answer would be [ADR-0038](./0038-widening-a-populated-table-takes-three-migrations.md)'s
shape one door along: deduplicate in a `--custom` migration, then let the generated one add the
index. **It is not written, and that is the decision this section records.** Writing it means
renumbering `0016` through the tail of Core's set — each `.sql` with its drizzle snapshot and its
journal entry — **to protect a database that does not exist**. Nothing has been published, so
nothing has ever installed kobai at a version carrying `0012` and not `0016`; the only databases
that have applied this set are this repository's own, each created seconds before it is migrated,
and whatever a maintainer has pointed `devbox run up` at. That last clause is the whole of the
risk, and it is the one thing the first publish has to check.

### The question to ask before the first publish, and both answers

**Before the loopback pin comes out of any publishable manifest: has a database been migrated
from this checkout and *kept* — a staging environment, a demo, a long-lived local
instance — that reached `0012`, where `core_order` is created, without reaching `0016`?** Ask it at `0012` and not
at `0015`: a database left at any migration in that range may hold Orders written by the code that
placed two of them.

- **No, which is the expected answer.** Then the reason changes and the acknowledgement stays.
  Every database that can exist after the first publish is created by an installed version
  carrying `0012` and `0016` both, applies the whole run in one pass, and holds no row for the
  index to refuse — so the statement is safe for good, and
  `tests/migrations-are-safe-against-populated-tables.test.ts` should say *that* rather than cite
  this record. It stops being true only if some released version cuts Core's set between the two,
  which is not a thing a release does. **What changes there is the kind and not only the
  wording** (#161): the entry records which of two judgements it is, and the reason above is
  neither of them — nothing has been deduplicated, and the debt is no longer waiting on a
  release — so retiring it means adding a kind, with the one thing that would show *that* kind
  false. The union in that file is what makes stating it unavoidable rather than optional.
- **Yes.** Then either the deduplication is owed after all, in front of `0016` and with the
  renumbering it costs — or that database is dropped and recreated, which is the same answer at a
  fraction of the price and is available for exactly as long as it holds nothing anybody needs.
  **Asking before publishing is what keeps the cheap answer on the table**, because after the
  first publish the same question has to be asked of deployments the maintainer cannot see.

**Expiring does not mean deleting the acknowledgement**, and the obvious reading is wrong in a way
worth being exact about. That check reads one migration file at a time, so a unique index on a
table *that file* did not create is named whatever else is true — the safe shape ADR-0038
prescribes produces the identical finding, because the deduplication answering it lives in a file
of its own. The check's own words are that such a statement is "answered where a reason can be
written down beside it". So the entry is a place for a reason rather than a suppression, this
section is that reason, and what the first publish calls for is a rewritten reason. Deleting the
entry while `0016` stands turns the gate red — watched rather than assumed, by emptying the
constant and reading the failure, which names `0016` and that one statement.

**This section cannot be shorter than that constant, and that is asserted rather than trusted**
(#161). The correct ADR-0038 shape produces the identical finding, so the constant fills up with
two unlike judgements — a statement that is safe because an earlier migration deduplicated, and a
debt like this one that is merely unreachable while the licence holds. An entry now says which,
and an entry of the second kind **names this record and this heading**; the check fails unless
what stands under that heading names the migration back. So the reader this section is for —
somebody about to remove a loopback pin, who arrives here rather than at a test file — is holding
every debt that constant carries: one acknowledged on this licence's credit and argued in the
test alone cannot pass the gate, and neither can this section being emptied or renamed out from
under it. It says nothing about a debt taken somewhere else in the repository, which is why the
admission rule above is stated rather than enforced.

## Consequences

- **The codemod set is still empty and now honestly so.** ADR-0035's zero has meant "nothing
  has been broken" since it shipped; it now means "nothing has been broken that a codemod could
  migrate", which is a different claim and needed stating.
- **ADR-0024's open risk stays open, and the index now says why.** The upgrade gate still cannot
  prove a codemod transforms anything, because every break kobai has taken is the kind the
  Project's own compiler announces rather than the kind a codemod migrates. The first break that
  *is* — a renamed config key, a moved file — will close it.
- **The first release has tasks in it, and nothing in the gate can assert that any of them is
  done.** `tests/publish-guard.test.ts` guards the loopback pin; removing that pin on purpose is
  the act that ends this record's first rule, and whoever takes it should say so here. It is the
  same act "What else the licence is holding up" falls due on, so a reader who arrives to end the
  licence has both lists in front of them — which is the whole reason that section is here rather
  than in a record of its own.
- **This record is now two things, and only the first is in its title.** It states the rule about
  promised surfaces and registers the breaks taken under it; it also holds the one debt that rests
  on the same licence and had nowhere else to be written down (#152). If that second list ever
  grows past a couple of entries it wants a record of its own — *what the first publish falls due
  on* is a different subject from *what may be broken before it*, and the register's own reading of
  its length depends on counting broken surfaces and nothing else.
- **`docs/extension-points.md` §2 points at this record**, because that is where a Developer is
  told the Step signature is the flagship promise, and it is the page they will re-read the
  moment the promise moves.
