# A Payment records whether the money arrived

> **The count in the first sentence is out of date and nothing else here is.**
> [ADR-0070](./0070-a-payment-the-shopper-completes-at-their-bank.md) shipped
> `@kobai/plugin-stripe`, so a second provider exists and the reference Project takes it when its
> environment is configured for one. That provider answers `received: true` for money that has
> left a Shopper's bank and `received: false` for a payment Stripe reports as `processing` —
> which is this record working exactly as designed, in the case it was written for. `manual`
> still answers `received: false`, and is still what a deployment with no bank settles with.

[ADR-0053](./0053-core-owns-the-payment-record-and-ships-no-provider.md) gave Core a Payment
record and no provider, and the one provider that existed when this was written — the reference
Project's `manual` — **moves no money**. It records that a Merchant will be paid out of band and answers `ok: true`,
which is the same answer a card processor gives after taking the money. Every Order the
reference Project takes therefore looked settled, and #103's criterion is precisely that it must
not: *an Order that has not been paid is visibly distinct, so a manually settled Order is not
mistaken for a completed one.*

Decided: **`PaymentOutcome`'s success variant carries an optional `received`, and the Payment
record carries it as a column.** `true` is money in hand; `false` is a payment arranged rather
than taken. It is written at Capture from what the provider said, and nothing ever updates it.

## Why here and not somewhere else

- **Not `payment: null`.** That already means something else — an Order kobai holds no account
  of the money for at all, which is every Order placed before ADR-0053's record existed. An
  arranged payment has a provider, a reference and an amount; erasing the record to signal that
  it is unpaid would throw away what a Merchant needs to chase it.
- **Not the provider's name.** Reading `provider === "manual"` would have Core interpreting a
  string a Project chose, about a provider Core promises nothing about. The distinction belongs
  to the provider's *answer*, which is the thing Core does define.
- **Not an Order-level field.** Whether the money arrived is a fact about the Payment, and the
  Order already reports its Payment. A second place to look would be a second thing to keep in
  step with a record that is never edited.

## Why a boolean, and why it defaults to `true`

`ok: true` has meant *takes the money* since the interface shipped, so a provider written before
this field existed keeps meaning exactly that, needs no edit, and is not silently reinterpreted —
which is what makes the addition safe under
[ADR-0019](./0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md).
`PaymentOutcome` runs from a provider to Core, so growing it is additive in the direction that
matters; the column takes the same default and needs no backfill migration
([ADR-0038](./0038-widening-a-populated-table-takes-three-migrations.md)'s three-step dance is
for a value that has to be guessed, and this one is what the old contract already said about
every row that exists).

**The rows that already exist are backfilled `true`, and that is the one uncomfortable part.**
AGENTS.md says a backfill value *"has to say the fact was never recorded, not guess at it"*, and a
boolean has no value for *never recorded*. Two things make `true` the right answer anyway. It is
not a guess: under the old contract `ok: true` asserted that the money moved, so `true` is what
every existing row already claimed about itself, carried forward unchanged. And the rows that
claim it wrongly are the reference Project's own — `manual` answered `ok: true` while taking
nothing, which is the bug this ADR fixes — of which there are none outside a Developer's laptop,
because nothing is released
([ADR-0034](./0034-kobai-is-published-and-the-reference-project-is-what-create-kobai-generates.md))
and `core_payment` is one migration old.

The alternative was a nullable column, `null` meaning *nobody recorded this*. It was rejected
because it buys correctness for a one-migration window at the price of a permanent tri-state in a
promised API shape: every client would narrow three ways forever to describe rows that only ever
existed before the first release. **A deployment that did place Orders through an arranging
provider before this migration should correct those rows by hand**, and there is no automatic way
to do it — Core cannot infer from a provider's name what that provider meant.

**It is a record, not a status.** There is deliberately no second value for *pending*, no route
that settles one, and no way to move it: an Order is immutable
([ADR-0009](./0009-cart-and-order-are-separate-and-orders-snapshot.md)), and a payment lifecycle
— settling later, hearing a bank on a webhook, resuming a redirect — needs events (#70) and
belongs to the specs that own them. Collecting an arranged payment happens exactly where it did
before: outside kobai. The Returns spec owns what a refund *is*, and refunding an arranged
payment is the same problem it already had.

## Consequences

- **The reference Project's `manual` provider answers `received: false`**, and the Admin shows
  three states rather than two: paid, awaiting payment, and no payment recorded.
- **A provider that arranges rather than takes now has a way to say so**, which is the honest
  shape for an invoice, a bank transfer or cash at the counter — the flows a Store most likely
  starts with before it takes cards.
- **If a payment lifecycle is ever wanted, this is not it and does not block it.** A later spec
  that adds one adds its own record beside the Payment; what it must not do is start writing to
  this column, because that would make an immutable record editable through the back door.
