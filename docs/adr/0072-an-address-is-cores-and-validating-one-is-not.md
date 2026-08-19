# An Address is Core's, and validating one is not

Clarifies [ADR-0015](./0015-shopper-supplied-input-is-project-owned.md). Core models a structural
**Address**, snapshots it onto the Order under ADR-0009, and checks **nothing beyond its shape**.

## Why this is not obvious

ADR-0015 draws a line — Core owns Merchant-supplied catalog data, and Shopper-supplied input
belongs to the Project — and a shipping address is submitted by a Shopper, so the letter of that
ADR puts it on the Project's side. Following the letter would be wrong: shipping rates, tax and
Fulfilment are all computed **from** an address, and that arithmetic is Core's. A `requiresShipping`
that Core asks, copies onto a Fulfilment at Capture, and can do nothing with is what the schema
holds today.

The test that separates the two: **the printing customer's uploaded artwork has no meaning to Core
and no two businesses want the same validation of it; an address is an input to Core's own Steps.**
ADR-0015's line survives intact — it is about bespoke input, not about the structural fields
commerce arithmetic depends on.

## What is decided

- **Core owns an Address entity** — country, lines, postal code, and a reference to a Region — and
  snapshots it onto the Order, because an Order that read an address live would be rewritten by a
  Shopper correcting their details a year later (ADR-0009).
- **Core validates shape and nothing else.** Address formats differ by country to a degree no
  library settles, and a real check belongs to a Project or a Plugin. This is the rule `contract.ts`
  already states — schemas are structural, and "whether an address looks like one" is a rule that
  stays in the module that owns it.

## Consequences

- Refusing a badly-formed address is a Project's decision, and a deployment that wants none is
  served.
- The Region reference is why [ADR-0069](./0069-what-done-means-and-the-journey-that-says-so.md)
  puts Region and Channel ahead of shipping and tax: an Address with nothing to resolve against
  would be the retrofit ADR-0005 warns is agonising.
