# Catalog deletion refuses rather than cascading or releasing

> **The open question at the foot of this record is settled by
> [ADR-0062](./0062-a-variant-is-corrected-in-place-and-a-price-is-superseded.md).** "Until #144,
> recreate it is the supported repair" was true when this was written and is not now:
> `PATCH /admin/variants/{id}` corrects a Variant's SKU, its Fulfilment Strategy and its
> metadata, and it is never refused for a live hold. Both refusals below are unchanged — the
> argument that separates them from an update is in that record.

#115 (PR #143) gave a Merchant three delete routes, and two of them can refuse for a reason that
is a decision rather than an accident:

| Refusal | Where | What it means |
| --- | --- | --- |
| 409 `last-variant` | `DELETE /admin/variants/{id}` | This is the only Variant of its Product, and every Product has at least one ([ADR-0008](./0008-variants-are-sellable-and-prices-are-rows.md)). |
| 409 `stock-is-reserved` | `DELETE /admin/variants/{id}` and `DELETE /admin/products/{id}` | Stock is claimed right now by an Order being placed ([ADR-0018](./0018-one-reservation-model-implemented-without-holds.md)). |

**Deleting a Price is never refused** — its route declares no 409 at all, only the two ways an
address can be wrong and the refusals every admin route carries — and that is
load-bearing rather than incidental, for the reason the last section gives.

The decisions are settled and this record is not reopening them. What was missing is that they
lived only in `packages/core/src/catalog/delete.ts`, in PR #143's body, and in a comment on a
closed issue — so the next person to ask "why can I not delete this Variant" would find a 409 and
a doc comment where they went looking for an argument.

## Why a refusal is worth a record at all

A refusal is the shape a program sees. `Refusal.reason` is what a storefront or the Admin
branches on, and branching on `stock-is-reserved` is depending on kobai's answer to "what does a
delete do about a claim on stock" — a domain decision, not an implementation detail.

**And nothing is watching that string.** Both routes answer with `contract.Refusal`, which types
`reason` as `z.string()`, so `@kobai/client` types it `string` too; the two words appear in the
generated description only as prose inside the 409's `description`. Core does have the stronger
shape where it has chosen to use it — `SessionRefusal`'s and `ApiKeyRefusal`'s `reason` are enums
built by a mapped `satisfies` over the rejections each gate can actually make, `PermissionDenied`'s
is a literal and `OrderRefusal`'s a closed set of one — and it also has the deliberately open one,
`PlaceOrderRefusal`, whose `reason` is a string precisely because a Project's Step may refuse with
anything. These two are neither: the set *is* closed, in `ProductDeletion` and `VariantDeletion`,
and the schema does not say so. A renamed reason here therefore compiles, passes the gate,
regenerates cleanly, and breaks a caller at runtime. That is precisely the class
[ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md)'s "a compile error
is the notice" cannot cover: **there is no compile error, so the written record is the whole of
the notice.**

## `last-variant`: refusing rather than cascading

ADR-0008 makes the Variant the only sellable thing and gives every Product at least one, and
`catalog/write.ts` keeps a Product with none unreachable by giving the API no way to create one.
This refusal is **the other end of that same invariant**, not a second rule: creation closes the
door and deletion declines to open it.

The alternative was to take the Product with it. Rejected: a `DELETE` that removed a resource its
caller never addressed is a worse thing for a route to do than to refuse — a Merchant tidying up
Variants would silently lose the Product, and no status code can un-say that. The fix is one call
away and the refusal's detail names it, `DELETE /admin/products/{id}`, which is the route that
*does* remove both. So nothing is unreachable; only the phrasing is constrained.

**It is an invariant rather than a check, so it is enforced with a lock.** `deleteVariant` takes
`for update` on the Product row before it counts siblings, because two Merchants deleting the two
Variants of one Product at the same instant would each see the other's, each pass, and leave the
Product with none — the state the refusal exists to prevent.

**What would reopen it:** ADR-0008 ceasing to require a Variant. A draft Product, or a Product
that is a container for Variants added later, would make the zero-Variant state legitimate, and
this refusal would go with it rather than be argued separately.

## `stock-is-reserved`: refusing rather than releasing

The claim being refused is a **live** one — a hold taken by an Order that is being placed at this
moment, which `variantsWithClaimedStock` reads as `core_inventory.reserved > 0` rather than by
counting `core_reservation` rows, so there is one answer to "is this spoken for" rather than two
that can disagree.

**It is not a new refusal, and that is deliberate.** `PUT /admin/variants/{id}/inventory` already
answers `stock-is-reserved` at 409 about the same units and in the same words: a Merchant cannot
recount what is spoken for either, and both clear the same way. So the reason string is shared by
three routes, which is one more reason a rename is not a local edit.

**Why releasing was rejected is a fact about where the hold sits in the spine.**
`placeOrderWorkflow` declares seven Steps in this order:

```
load-cart → price-lines → apply-adjustments → calculate-tax → hold-reservations → take-payment → capture-order
```

`hold-reservations` is **in front of** `take-payment`, deliberately: ADR-0009 makes an Order
immutable, so the Order write has to be the last thing that can fail, which puts the money
immediately before it and the claim on stock before *that* — a Shopper whose card is charged is a
Shopper the stock was already put aside for. And `capture-order` **consumes** those holds inside
the very transaction that writes the Order, so stock and Orders cannot disagree.

Follow a release through that. A delete that released the holds it found would be releasing them
out from under a placement that is somewhere in the last three Steps. `inventoryProvider.consume`
is guarded — it refuses to take units that are no longer held, precisely so a swept hold cannot
be sold twice — so Capture throws, and it throws **past `take-payment`**. The runner unwinds, and
`take-payment`'s compensation refunds. The net effect of a Merchant clicking delete is a Shopper
charged and then refunded for a purchase that never happened, at a moment nothing in the request
can explain to them.

**Refusing also closes the race rather than opening it.** The check takes `for update` on the
Inventory rows, after the `core_variant` rows and in the order `capture-order` takes the same
rows — so a placement in flight makes the delete wait rather than overtake it, and a hold placed
one instant after the answer cannot make the answer a lie.

### Considered options

- **Release the holds as part of the delete.** Rejected, above: it fails a Capture past the
  Payment, which is a refund a Shopper never asked for.
- **Delete anyway and leave the rows to the sweeper.** Rejected. It has the same charge-then-refund
  failure, and it also strands rows: `core_reservation.subject` is text with no foreign key, so
  nothing cascades, and — as #115's first comment put it — that "only looks free until the row
  count is somebody's problem".
- **Refuse only on the Variant route, not the Product's.** Rejected: the refusal would be one call
  wide. Deleting a Product takes every Variant of it, so every one of them has to be free to go,
  and `deleteProduct` asks the same question of all of them.

## Why the refusal clears itself, and why that is what makes it acceptable

A refusal a Merchant cannot get past is a bug wearing a status code. This one is not, on two
independent grounds, and neither requires kobai to grow anything.

**A hold does not persist.** It becomes an Order — Capture consumes it — or it lapses: the window
is fifteen minutes, and the sweeper of
[ADR-0057](./0057-the-reservation-sweeper-is-an-interval-not-a-job.md) releases lapsed holds a
minute at a time and gives the units back. So the longest a delete is refused for is roughly the
length of one abandoned checkout, and waiting is a complete answer — in a deployment that started
the sweeper, which ADR-0057 makes a Project's explicit call and whose absence is already a worse
problem than this one.

**And the urgent need is served by a route that never refuses.** A Merchant who must stop selling
something *now* is not waiting on anybody's checkout: removing the Price is not refused for any
reason but a bad address, and an unpriced Variant can neither be quoted nor put in a Cart. The
selling stops at once; the row goes when the last hold clears. That is why "there is no refusal
for the last Price" belongs in this record rather than in a footnote about that route — **it is
the pressure valve the two refusals above lean on.**

## What a delete leaves behind, and why that is right

`core_reservation.subject` is text with no foreign key (ADR-0018) — deliberately, so that Capacity
can arrive later as a second provider without a schema change — and the cost is that nothing
cascades. **The consumed and released Reservations naming a deleted Variant survive it, and
should.** A Reservation is Core's record that a claim *happened*, on a day nothing can change now;
deleting the Variant does not make it not have happened, exactly as it does not un-place the
Orders that ADR-0009's snapshot keeps readable. Live ones cannot be in that set, because live is
the thing being refused.

**One tolerance downstream is now belt-and-braces rather than the expected path, and should
stay.** `inventoryProvider.release` treats "the Variant stopped being counted" as a release that
needs nothing given back, so the sweeper does not meet the same unreleasable row every minute for
the rest of the deployment's life — the case #106 added it for, before anything could delete a
Variant. This refusal makes that state unreachable *through the API*; it does not make it
impossible, since nothing stops a hand-run `DELETE` (ADR-0004's unmediated writer), and removing
the tolerance on the strength of this decision would turn a tidy-up into a permanent failure.

## Consequences

- **Both reason strings are now promised in prose and nowhere else.** Until the first publish,
  ADR-0058's licence permits changing them outright; after it, there is no compiler to announce a
  change, so either they get the enum treatment `SessionRefusal` already has, or a change is a
  major with a written notice. Giving `Refusal.reason` a narrowed shape here is a decision nobody
  has taken and this record does not take it.
- **Which record puts the HTTP surface under semver is unwritten, and it is not the first time
  that has mattered** — ADR-0058 had to satisfy itself that "the HTTP contract did not break" with
  no rule to apply, and reached the answer by arguing the change was additive.
  [ADR-0019](./0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md)
  promises ADR-0003's five Extension Points (and, since ADR-0047, the test harness); the HTTP
  surface is not among them, yet
  [ADR-0010](./0010-the-admin-ships-in-one-container-and-gets-no-private-api.md) forces the Admin
  onto it and [ADR-0002](./0002-headless-the-storefront-is-out-of-scope.md) leaves a storefront
  nothing else to use. **This record does not settle that** — it is a gap noticed while writing
  one, and it wants its own decision. What it does settle is that these two refusals are not
  exempt from whatever the answer turns out to be.
- **`stock-is-reserved` answers for Inventory alone.** Only that provider's arithmetic is read,
  and only that module knows a `subject` is a Variant's identifier. The day a second provider can
  claim something *about a Variant* — a Capacity claim on a period (ADR-0018) — a delete route
  still reading the column would be answering half the question, and the refusal has to start
  asking the providers instead. `variantsWithClaimedStock`'s doc comment carries the same warning
  where it would be acted on.
- **Neither refusal is enforced by the schema.** No constraint keeps a Product's last row from
  going; `deleteProduct` and `deleteVariant` are where both rules live, and a hand-run `DELETE`
  can leave a Product with no Variant — the same class of unmediated write
  [ADR-0037](./0037-updated-at-is-a-trigger-because-core-does-not-mediate-every-write.md) put
  `updated_at` in a trigger for. These are rules about kobai's surface, not invariants Postgres
  holds, and a reader should not infer more from a 409 than it says.
- **Until #144, "recreate it" is the supported repair**, because no route updates a Variant. That
  cost is accepted rather than hidden: recreating discards the Variant's price history and its
  Inventory row. What an update may change on a record Orders hold snapshots of is a separate
  question — ADR-0009 answers the shared half, and the rest (a changed SKU against
  `core_reservation.subject`, a swapped Fulfilment Strategy under a stock count, a Price corrected
  versus superseded) is constrained by nothing here.
