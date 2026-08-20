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
- **#292 — `resolve-price` grew a market: `PriceResolutionRequest`, `LoadedPrices` and
  `ResolvedPrice` each gained a `region` and a `channel`.** Extension Point 2, and the first
  break taken under this licence *on purpose* rather than as the cost of a change that had to
  be made some other way. A Price now carries a nullable Region and Channel (ADR-0008's
  predicted constraint columns), so pricing is asked *somewhere* — and a Step that could not see
  where would be a Step that cannot implement the rule. The argument is on `PriceMarket` in
  `packages/core/src/pricing/resolve-price.ts`; ADR-0074 is what it spends.

  **The blast radius is every replaced Step in that Workflow, and the compiler reaches all of
  it — but only because the *output* moved too.** That is the part worth writing down, because
  it is not obvious and it decided the shape: growing an *input* alone breaks nobody. TypeScript
  checks a function-valued parameter contravariantly, so a Step declared
  `(input: LoadedPrices) => ResolvedPrice` still compiles when `LoadedPrices` gains a field —
  the Step is simply handed more than it reads. A replaced `select-price` would then have gone
  on answering as though every Shopper were in one market, silently, which is exactly the "wrong
  prices rather than a build error" this spec's own story 20 asks to be spared. So the market
  travels **out** as well as in: `ResolvedPrice` is what a replacement *builds*, and a missing
  property there is `TS2739` at the Project's own build. `everythingCostsOneCent` in the
  reference Project is the worked example and was updated in the same change — two lines to
  hand the market back, and one decision about the currency, which it now honours although it
  throws the amount away.

  What did **not** break: an inserted `before`/`after` Step that passes the value through
  (`@kobai/plugin-price-log`'s `record-price-resolution` is untouched), and every HTTP client —
  `ResolvedPrice` and `Price` gained fields, which is additive in the direction ADR-0060 permits
  in a minor. `select-price`'s refusal words are unchanged.

  **No codemod, on this record's own rule and on both of its grounds.** The compiler names the
  file and the property; and what a Project's own pricing rule should *do* with a Region — read
  it, ignore it, refuse in it — is a question only that Project can answer, so a machine writing
  `region: input.region` would turn the build green while leaving the decision untaken. That is
  #117's second argument arriving intact one Workflow along.
- **#293 — `place-order` grew a market: `PlaceOrderRequest` gained a `channel`, and `LoadedCart`
  gained one beside `CartToPlace`'s `currency` and `regionId`.** Extension Point 2, and the
  second break taken under this licence on purpose. #292 constrained a Price by Region and
  Channel and left `price-lines` reading the Store's default Region and passing `channel: null`
  outright — so a Store with either kind of constrained Price quoted one number on its product
  page and charged another at checkout, and a marketplace key got storefront prices at the till.
  Closing it means the placement is asked *where* and *through what*, exactly as the price route
  is. The argument is on `PlaceOrderRequest` and `CartToPlace.currency` in
  `packages/core/src/order/`; ADR-0074's amendment is what it spends.

  **The notice sits where the compiler looks, which is the lesson #292 wrote down one Workflow
  along.** Growing `PlaceOrderRequest` alone would break nobody — TypeScript checks a Step's
  `run` parameter **contravariantly**, so a replaced `load-cart` declared
  `(input: PlaceOrderRequest) => LoadedCart` goes on compiling when the input gains a field, and
  would have gone on placing every Order as though every Shopper were in one market. So the
  growth is on the **output** too: `LoadedCart` is what a replaced `load-cart` *builds*, and its
  three new properties are `TS2739` at the Project's own build. A replaced `price-lines` takes
  the wider `LoadedCart` and is untouched, which is right — it is handed more than it read
  before, and what it does with the market is the decision only that Project can take.

  What did **not** break: an inserted `before`/`after` Step that passes the value through; every
  Step downstream, which carries `cart` rather than rebuilding it; and every HTTP client, since
  `Cart` gained `currency` and `region` and lost nothing — additive in the direction ADR-0060
  permits in a minor. The refusals grew by three words, which is the sharp edge that table names:
  a client with an exhaustive `switch` over `CartRefusal` gains three arms to write.

  **No codemod**, on this record's own rule and on both of its grounds: the compiler names the
  file and the property, and what a Project's own `load-cart` should say about the market is a
  question only that Project can answer.
- **#276 — `PriceRefusal.workflow` made optional.** The promised HTTP surface, and ADR-0060's
  "making a present field optional is a break" exactly: a client narrowing `error.workflow.failed`
  off a refused price stops compiling and has to ask whether the field is there. The argument is
  written on the field in `packages/core/src/http/contract.ts` and at
  `resolvePriceRoute` in `packages/core/src/http/store.ts`, and the short of it is that #276 made
  `GET /store/variants/{id}/price` refuse a Variant whose Product a Shopper may not see **before**
  `resolve-price` runs — so there is no run to report, and the alternatives were to invent a
  `failed` slot that never failed or to answer a shape the description does not carry.
  `PlaceOrderRefusal.workflow` was already optional for the same reason one door along, which is
  what makes this the shape both now have rather than a second one. The blast radius is one
  narrowing on the two price routes; `packages/client/src/client.test.ts` carries it and says so.

## What else the licence is holding up, and where that list went

The licence is spent on more than promised surfaces. **Anything in this repository that is
survivable only because nothing has been published falls due at the same act** — the deliberate
removal of the loopback pin — and that act happens once, so the debts belong where whoever takes
it will already be reading. This section used to be that place. It is not any more, and the
reason is the one this record's own consequences gave: the list grew past a couple of entries,
and *what the first publish falls due on* is a different subject from *what may be broken before
it*.

**The list is
[ADR-0061](./0061-what-the-first-publish-owes.md), and it is the whole of it.** It carries what
stood here — `0016`'s unique index on `core_order.cart_id`, why the deduplication in front of it
was not written, the one question to ask before the first publish and both answers to it — along
with four other things falling due at the same act that had been recorded in four other places:
this record's own expiry, ADR-0034's version policy, changelog and provenance, the rule that a
version bump has to happen in a commit with its artifacts regenerated in it, and manifests that
name no repository and owe their licence text to whichever tool packs them.
`tests/publish-guard.test.ts` holds that record to carrying every one of them and holds each of
their argued-in files to naming it back, so the list a publisher reads cannot be shortened by an
edit anywhere (#162).

**A debt recorded where the decision it qualifies lives stays there**, which is ADR-0061's first
rule and was this section's before it: the argument belongs beside the decision it is a
consequence of, and the list carries the entry pointing at it. What moved to ADR-0061 in full is
the one kind that has no such home — a debt no record argues, whose only trace was a constant in
a test file.

**This record's own entry on that list is its first rule expiring**, and the register above is
what a reader holding a compile error dates against it. Both are still here, because both are
about breaking a promised surface, which is what this record is for.

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
  the act that ends this record's first rule, and whoever takes it should say so here. **The rest
  of those tasks are [ADR-0061](./0061-what-the-first-publish-owes.md)**, which is where a reader
  who arrives to end the licence now finds the whole set, this record's expiry among them. What
  the gate gained (#162) does not change the sentence above: it holds that list to naming every
  place an obligation is argued, and every one of those places to naming the list back, and says
  nothing about whether any of them has been done.
- **This record went back to being one thing, which is the one in its title.** It states the rule
  about promised surfaces and registers the breaks taken under it. The second list it carried for
  want of a home (#152) is ADR-0061 (#162), taken up on exactly the terms this bullet set: *what
  the first publish falls due on* is a different subject from *what may be broken before it*, and
  the register's own reading of its length depends on counting broken surfaces and nothing else.
- **`docs/extension-points.md` §2 points at this record**, because that is where a Developer is
  told the Step signature is the flagship promise, and it is the page they will re-read the
  moment the promise moves.
