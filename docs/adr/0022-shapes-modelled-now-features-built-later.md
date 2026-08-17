# Translations, Adjustments and Returns are modelled now; Bundles are ruled out

> **Amended by [ADR-0024](./0024-one-release-target-v1-and-1-0-are-the-same-thing.md) and
> [ADR-0027](./0027-holds-roles-and-bundles-re-decided-on-platform-terms.md).** With one
> release target, Translations, Adjustments and Returns are *features*, not deferred
> shapes. Bundles are **not ruled out** — they are a Plugin. The analysis below of why
> composition forks inventory, pricing and fulfilment stands, and is the reason it is a
> Plugin rather than Core.

Three deferred features get their **schema and vocabulary in v1 even though the feature is
not built**: Translations (a translation table per translatable entity, with one locale),
Adjustments (a discount or surcharge line on Line Item and Order), and Returns (an entity
referencing an immutable Order, restocking through ADR-0018's Reservation interface).
**Bundles — a Variant composed of other Variants — are ruled out, not deferred.**

## The criterion

The only question asked of each deferred feature was whether deferring it costs a retrofit
later or nothing at all. These three cost a retrofit that touches everything: translatable
fields are a schema shape that Vendure and Saleor both carry from day one because adding
them later is agony; Adjustments change what "line total" means in every Order snapshot, tax
base and refund; and ADR-0009 makes Orders immutable, so a Return has to be a separate
entity rather than an edit, which is a decision worth making before there is order history.

This is the same trade already made for Price rows (ADR-0008), the Reservation interface
(ADR-0018), Fulfilment as its own entity (ADR-0014) and Workflow compensation (ADR-0017):
**get the shape right while it is free, build the feature when it is needed.**

Notably, **the lead-time surcharge of ADR-0012 is already an Adjustment.** The mechanism is
being built regardless, so it is named correctly the first time rather than renamed later.

## Why Bundles are ruled out rather than deferred

Composition is not a shape that can be stubbed. The moment a Variant can contain Variants,
inventory, pricing and fulfilment each fork, and stubbing the table buys nothing because all
the cost is in the logic. A printing store does not need it, and an explicit no is more
useful to a future reader than a vague "later".

## Consequences

Everything else deferred — gift cards, B2B and quotes, subscriptions, search, reviews,
wishlists, abandoned cart, yield pricing, Reservation holds, proofing, Shopper auth, RBAC —
stays deferred, because the architecture already anticipates each and none costs a retrofit.
