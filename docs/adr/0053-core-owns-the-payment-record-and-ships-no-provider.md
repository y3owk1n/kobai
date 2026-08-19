# Core owns the Payment record and ships no provider

> **Amended by [ADR-0070](./0070-a-payment-the-shopper-completes-at-their-bank.md).** Core still
> ships no provider and still implements the interface nowhere; what has changed is the sentence
> below saying "a Stripe provider is a later spec". That spec shipped as `@kobai/plugin-stripe`,
> so the reference Project now has **two** and picks between them from its own environment: given
> Stripe's settings it takes payments a Shopper completes at their bank, and given none it settles
> out of band through `reference/src/payments/manual.ts` as it always has. **Both are working
> deployments**, which is this record's own rule applied one level out — misconfiguring payments
> must not take a Store down any more than not configuring them at all does. `manual` is not
> superseded: it is what a deployment with no bank uses, it is what a Developer's scaffolded
> Project starts life with, and it is the implementation from a Project's **own source** that the
> upgrade gate carries across a Core major.

Payment had no decision recorded anywhere. It appears in ADR-0028's Core list and in its
Plugin list **neither** time, and its only mentions in the whole repository are as an example
— "payment capture timing" in ADR-0003, "capturing a payment" in `CONTEXT.md`'s definition of
a Workflow, "available payment and shipping" under Region.

Decided: **Core owns the Payment record. The provider is a named interface. Core ships no
implementation of it.** The reference Project supplies the one that exists,
`reference/src/payments/manual.ts`, wired in `kobai.config.ts`.

## Why the record is Core's

ADR-0028's membership test is "does omitting it make the rest of Core wrong?" Omit the Payment
record and an Order — which ADR-0009 makes "the immutable financial record of a completed
purchase" — holds no record of money received, and a Return has nothing to refund against.
That is the rest of Core being wrong, the same way it is wrong without Adjustments.

## Why Core ships no provider

This is the part that will look like an omission and is not.

If Core shipped `manual`, then dependency substitution would have two interfaces and every
implementation of both would still be Core's own — which is the exact non-proof #72 already
reports against `Logger`: "what is proven is that the seam works, not yet that anybody has put
something of their own through it." Shipping a second interface the same way would reproduce
that finding rather than close it.

So the `manual` provider is the **Project's** source, generated into `create-kobai`'s template
like the Admin is (ADR-0033), and owned by whoever scaffolds it. Between this and
[ADR-0052](./0052-a-fulfilment-strategy-is-dependency-substitution.md), dependency
substitution gets its first implementations from outside Core in the same spec.

It also gives ADR-0036's unwinding its first real case. `place-order` holds Reservations, then
takes payment, then consumes and writes the Order in one transaction — so a payment that
succeeds and a capture that fails leaves money moved and stock claimed, with a compensation
that has to refund. Until now compensation has been unit-tested against a Workflow where
nothing was at stake.

## What is decided

- **`PaymentProvider` is a named interface** under Extension Point 3, wired through
  `kobai.config.ts`. Core defines it and implements it nowhere.
- **A deployment with no provider configured still boots**, serves its catalog and serves the
  Admin. It refuses `place-order` alone, with reason `no-payment-provider`. Refusing to boot
  would be wrong: a store that cannot yet be bought from is still a store worth reading, and
  ADR-0048 already reserves boot refusal for a database that cannot be migrated.
- **Payment capture is always written in full.** ADR-0009 and ADR-0018 use bare "capture" for
  the moment an Order becomes immutable and Reservations are consumed. The money sense is a
  different event and must never be written bare, for the reason `CONTEXT.md` bans
  "time-based pricing": one word, three mechanisms.

## Consequences

- **kobai ships no way to take real money, deliberately, and should say so.** A Stripe
  provider is a later spec and an obvious first Plugin. What ships is the interface plus a
  Project-owned `manual` provider — the Merchant marks an Order paid out of band.
- **`no-payment-provider` is a refusal, not a crash**, and joins `place-order`'s reason map
  alongside `payment-declined`. Following `resolve-price`'s existing shape in
  `packages/core/src/http/store.ts`, Core's own reasons are mapped with `satisfies` so an
  unmapped one fails the build, and `reason` stays an open string so a Plugin's Step can
  refuse with something Core has never heard of.
- **Refunds are not decided here.** A compensation that refunds a payment needs the provider
  to offer it, which shapes the interface; Returns are a later spec (ADR-0028) and will have
  more to say about what a refund *is*. What this ADR fixes is that the compensation exists
  and that the provider is asked, not what a partial refund means.
