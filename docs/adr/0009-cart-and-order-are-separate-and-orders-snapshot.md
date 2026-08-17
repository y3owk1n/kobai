# Cart and Order are separate, and Orders snapshot everything

**Cart** and **Order** are distinct entities, not one entity with a status. A Cart is
mutable, disposable and unauthoritative. An Order is immutable and financial. And an
Order's Line Items hold a **snapshot** — title, SKU, price, tax rate as at capture —
referencing the Variant by ID for navigation only, never for display or arithmetic.

## Why separate

Fusing them means every financial query must filter on status, and one forgotten filter is
a silent correctness bug in the books rather than a visible error. The two are governed by
completely different rules — one is expected to change and vanish, the other must never
change again — and a single table cannot enforce both.

## Why snapshot

A Line Item that joins live to the catalog means renaming a Product silently rewrites
history, deleting a Variant destroys an Order, and changing a price retroactively falsifies
past revenue. This is the failure mode most likely to be introduced by a greenfield
commerce engine optimising for normalisation, and it is close to unfixable once real order
data exists — the original values are simply gone.

## Consequences

Order rendering never joins the catalog for anything a Shopper or accountant sees. Catalog
data is freely mutable and deletable *because* Orders do not depend on it, which is a
feature, not an accident.
