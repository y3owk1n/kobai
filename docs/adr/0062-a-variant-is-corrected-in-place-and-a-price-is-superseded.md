# A Variant is corrected in place, and a Price is superseded

`PATCH /admin/variants/{id}` changes a Variant's **SKU**, the **Fulfilment Strategy** it points
at, and its **metadata**. It changes nothing else, it is refused for nothing a create would
allow, and it is **never** refused because stock is claimed.

[ADR-0009](./0009-cart-and-order-are-separate-and-orders-snapshot.md) is what makes any of this
safe, and it answers the shared half once: an Order's Line Items snapshot title, SKU, unit
amount and tax, and a Fulfilment snapshots what the Strategy answered — so catalog data is
freely mutable *because* Orders do not depend on it. [ADR-0059](./0059-catalog-deletion-refuses-rather-than-cascading-or-releasing.md)
proved that half through the API for deletion; `packages/core/src/catalog/update.test.ts` proves
it for correction, by reading an Order back **as text** either side of a correction to the very
Variant it names.

After that the two questions diverge, exactly as #144 said they would. Deletion had one
invariant to defend and one decision to take. Correction has a **field-by-field** question, and
the four answers below are not alike. Each is cheap to settle now and expensive once a
deployment has price history.

## The SKU is free to move, and a live hold does not touch it

**Decided: mutable, refused only when another Variant already carries the SKU (409
`sku-taken`).**

Two things could have held it still and neither does.

An **Order** names a SKU, and it names its own copy: `core_order_line_item.sku` is written at
Capture and joined to nothing (ADR-0009). Renaming the Variant a year later leaves every Order
saying what was bought under the name it was bought under, which is the property the byte
comparison asserts.

A **Reservation** names its subject by value — `core_reservation.subject` is text with no
foreign key, deliberately, so that Capacity can arrive later as a second provider (ADR-0018) —
and the value the Inventory provider writes there is the **Variant's identifier**, not its SKU
(`inventoryProvider.claimsFor`). An identifier is the one thing on the record that cannot be
corrected, so a hold taken before a rename is consumed or released after it without anything
having to be rewritten. That was checked rather than assumed: the test pauses a placement after
`hold-reservations`, renames the Variant under it, releases, and watches the Capture take its
two units off the shelf.

**Considered and rejected.** Leaving the SKU immutable and keeping "recreate the Product" as the
repair, which ADR-0059 recorded as the supported one — it discards the Variant's price history
and its Inventory row, which is the cost #144 exists to remove. And refusing a rename while a
hold is live, for symmetry with deletion — a refusal defending nothing, argued below.

**What the unique index does, and why it is not a `select`.** The check and the write are one
statement: `update … set sku = …` against `core_variant_sku_unique`, with the violation read
back as `sku-taken`. Postgres has no `on conflict` for an `update`, so the loser of two
simultaneous renames finds out by being thrown at — which is ADR-0018's rule applied the only
way it can be here. A read followed by a write would let both pass and surface as a 500.

## The Fulfilment Strategy swaps in both directions, and the stock count stays

**Decided: swappable, refused only when this deployment has not wired the name (422
`unknown-fulfilment-strategy`, creation's own refusal). The `core_inventory` row is left exactly
where it is, whichever way the swap goes.**

This is the headline case: #107 made `tracksInventory` load-bearing, so a Variant wired to a
Strategy a Project later stops wiring could only be repaired by deleting the Product — and
`place-order` already refuses a purchase of one (`unknown-fulfilment-strategy` at 409), which
means the broken state is reachable today and had no route that mended it.

**Leaving the count alone is not indifference; it is the state Core already models.**
`reservation/inventory.ts` says so in as many words: a Variant with a row whose Strategy says no
still sells freely, "a Merchant counted it once, or it used to be a poster", because the
Strategy answers *whether* stock is involved and the row only ever said *how many*
(ADR-0014, ADR-0052). So a swap to `digital` produces a state creation can already produce, and
a swap back to `physical` sells from the same shelf again — asserted in both directions.

**Considered and rejected: deleting the Inventory row on a swap to a non-tracking Strategy.**
Three counts against it, and the third is the serious one.

- It discards a number a Merchant went and counted, which is the same loss recreating the
  Product causes and half of what this ticket exists to stop.
- It deletes a resource the caller did not address — ADR-0059's argument against cascading a
  Variant's deletion up to its Product, in a place where the caller has even less warning.
- **It would break a live hold.** `inventoryProvider.consume` is guarded, so a Capture whose
  row had vanished throws — *past* `take-payment` — and the runner refunds a Shopper who was
  charged for a purchase that never happened. That is the exact failure ADR-0059 refuses a
  delete to avoid, and taking this option would have obliged this route to grow
  `stock-is-reserved` too. **That is the hinge**: the day an update takes something away from a
  live hold, the refusal comes back with it.

**Considered and rejected: refusing a swap while an Inventory row exists**, so that a Merchant
must delete the count first. It makes "a poster becomes a download" unreachable for exactly the
Variants anybody bothers to count, which is most of them.

**The other direction leaves a Variant sellable with no shelf, and that is allowed.** A
`physical` Variant nobody has counted has no row, is untracked, and sells freely (ADR-0018) —
which is what creating one and not counting it already produces, so a swap cannot reach a state
creation cannot. The route's description says so and names `PUT /admin/variants/{id}/inventory`;
refusing here would have been Core inventing a rule that "tracked" is mandatory, which it never
was.

## A Price is superseded, never corrected

**Decided: no route updates a Price, and `PATCH /admin/variants/{id}` carries none.**

ADR-0008 makes a Price a row precisely so that multi-currency, Region, Channel and quantity
breaks stay additive, and `select-price` resolves **newest first**. So the additive surface
*already is* the correction, and it needs no window in which the Variant is unpriced:

- `POST /admin/variants/{id}/prices` with the right amount — it wins from that instant;
- `DELETE /admin/variants/{id}/prices/{priceId}` for the row that was wrong, which is refused
  for nothing but a bad address (ADR-0059).

Doing it in that order never leaves the Variant unquotable, which the reverse order and a
delete-then-insert repair both would.

**Considered and rejected: `PATCH /admin/variants/{id}/prices/{priceId}` editing `amount`.** It
is not free — every path, every field and every `reason` on this surface is promised under
[ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md) — and it
teaches the edit-the-price-column model ADR-0008 spent a table on avoiding. The rule it would
have to grow is already visible: the day a Price gains Region, Channel or a quantity break,
changing one of those makes it a **different** Price rather than a corrected one, so the route
would need a refusal for exactly the fields that matter. Better to have no route than one whose
scope is about to be argued.

**The rule for that day, so it is not rediscovered:** what a Price *is* may one day be corrected
in place; what a Price *applies to* is always superseded. Adding a correction route later is
additive and cheap; removing one is a major.

## No update is refused for a live Reservation

**Decided: never — and no field differs.**

ADR-0059 refused a delete on a specific argument, not on a general caution: a delete removes the
thing a live hold depends on, and releasing the hold out from under a placement fails a Capture
past `take-payment`, so a Merchant's click becomes a Shopper's refund. Apply the same test to an
update and it comes out the other way. The `core_variant` row stays. The `core_inventory` row
stays (above). The `subject` a Reservation names is the identifier, which does not move. And a
placement in flight carries its Strategy answers and its claims from the front of the run —
`AppliedFulfilment` is asked once at `load-cart` and carried — so a swap mid-placement cannot
change what that placement does.

Nothing is taken away, so there is nothing to defend.

**Considered and rejected: copying `stock-is-reserved` onto this route for symmetry.** It would
make correcting a typo wait on a stranger's checkout, and a refusal a Merchant cannot act on and
that protects nothing is a bug wearing a status code. The delete route beside it *is* still
refused, and the test asserts both answers in one arrangement so the difference is a
demonstrated one rather than a described one.

## Consequences

- **This route adds no `reason` to the promised surface.** Every way it refuses —
  `invalid`, `variant-not-found`, `sku-taken`, `unknown-fulfilment-strategy` — is a word
  creation already answers with, so `CATALOG_REASONS` gained no key and a client branching on
  that set needs no new arm (ADR-0060). The mapped `satisfies` now covers
  `catalog/update.ts` too, so a rename there turns `contract.ts` red.
- **It is a `PATCH`, and each absent field means "leave it".** A `PUT` would make a client that
  omitted the open `metadata` bag clear it — data loss spelled as an ordinary request.
  `PUT /admin/variants/{id}/inventory` beside it stays a `PUT` because a count *is* the whole
  fact. `metadata` that is named is **replaced**, never merged, because a merge leaves no way to
  take a key back out.
- **A body naming nothing this route changes is refused at 400 rather than answered 200.** That
  is not a new judgement: the two `PATCH`es on the store surface already make it, in as many
  words — "a request that changes nothing is more likely a mistake than an intention"
  (`cart/write.ts`). Here it does a second job, because the schema strips a field the route does
  not carry: `{ "amount": 900 }` and `{}` are the same request, so the refusal is where a
  Merchant who tried to change a Price is told where a Price is set.
- **It takes no lock, and that is a decision about `catalog/lock.ts`.** The whole operation is
  one `update … returning`: existence is what came back, uniqueness is the index. A single
  statement takes one row lock, waits for nothing while holding it, and so cannot be half of a
  deadlock — which is how this stays clear of the hazard `lock.ts` names, where `addLineItem`
  and `capture-order` take the Cart and the Variant in disagreeing orders and are saved only by
  both Variant locks being **shared**. A field that ever needs a second row here has that to
  settle first, and the `core_inventory` row it would reach for is the one this record has just
  decided not to touch.
- **A Variant cannot be moved to another Product, and that is the one field left out on a
  different argument.** It is not a correction, it is a re-parenting: moving a Product's last
  Variant away empties it, which is the state ADR-0008 makes unreachable and ADR-0059 refuses a
  delete over — so the route would need `last-variant` and a whole second question about what
  the Prices and the count mean under a different Product. Nobody has asked for it.
- **What still has no route is a Product.** Its `title` and `metadata` are fixed at creation,
  which this record does not change and does not argue for. It is the same shape of question and
  a much easier one — a Product has no SKU, no Strategy and nothing claiming it — and it wants
  its own ticket rather than a paragraph here.
