# The extension surface, and what we promise stability on

> **Amended by [ADR-0047](./0047-the-test-harness-is-promised-surface.md) and
> [ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md).**
> The five Extension Points are still five and still closed — nothing attaches to a test
> harness or to an HTTP route at runtime. But two things outside them are promised anyway:
> `@kobai/core/testing`, which ships for the Plugin author who needs the same seam Core tests
> through; and kobai's **HTTP surface**, which under ADR-0002 *is* the product for a
> storefront Developer and under ADR-0010 is the only thing the Admin may use. So "anything
> not reachable through the five surfaces above" below means anything but those two — and
> neither is an Extension Point, because an Extension Point is a place a Project's or a
> Plugin's own code is *called*, and these are places kobai is *used*.

ADR-0001 removed the fork and moved the hard problem here: a Project and its Plugins can
only stay upgradeable if they attach to a surface Core promises not to break. We promise
stability on exactly four extension points — **configuration**, **events**, **dependency
substitution behind named interfaces**, and **Admin UI slots** — plus the flagship,
**workflow step override**. We promise nothing about anything else, and say so loudly.

## Explicitly not promised

Internal function signatures, module layout, Core's database schema shape, and anything
not reachable through the five surfaces above. A Developer may of course reach into these
— it is their Project — but doing so opts them out of the upgrade guarantee, and that
trade should be visible at the moment they make it, not at the next major version.

## Why workflow override is the flagship

Commerce customisation is overwhelmingly *process* customisation: tax calculation, price
resolution, shipping rate selection, discount stacking, fulfilment routing, payment
capture timing. Today, in every comparable platform, that work bottoms out in copying a
service and editing it. A named, typed, individually replaceable **Step** inside a declared
**Workflow** is a far better answer than an event hook, and it is where kobai intends to be
distinctly better than Medusa and Vendure rather than merely comparable.

## Consequences

Every promised surface is a permanent constraint on Core's own refactoring, which is why
the list is short and deliberately boring. Growing it is a one-way door; each addition
should be treated as its own decision.
