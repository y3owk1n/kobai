# One Reservation model, implemented without holds in v1

> **"No holds" superseded by [ADR-0027](./0027-holds-roles-and-bundles-re-decided-on-platform-terms.md).**
> Holds are in, with a TTL and a sweeper. The single Reservation interface and the
> atomicity requirement below both stand — and the latter matters more now, not less.

**Inventory** and **Capacity** are the same problem — a scarce resource claimed during
purchase — and go through one **Reservation** interface with two providers. v1 implements
that interface as **atomic check-and-consume at order capture, with no hold**.

## Why one model

A stocked Variant claims units; a made-to-order Variant claims production Capacity
(ADR-0012). Both are checked, held, consumed on capture, and released on abandonment.
Modelling them separately means building the same mechanism twice and diverging on the
hard parts.

## Why no holds in v1

Holds require TTLs, a background sweeper, and a class of race conditions, in service of
contention that is currently theoretical for a single low-volume store. Getting the *shape*
right while it is free and keeping the implementation small is the same trade made for Price
rows in ADR-0008: holds can be added later without changing the model.

## Consequences

**Atomicity is not optional.** Check-and-consume must be a row lock or a unique constraint,
never a `SELECT` followed by an `UPDATE` — otherwise the store oversells anyway and has
merely implemented the appearance of safety, which is worse than none.
