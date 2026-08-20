# Currencies are enabled by the Store and selected by the Region

Completes [ADR-0008](./0008-variants-are-sellable-and-prices-are-rows.md)'s multi-currency clause
and narrows [ADR-0005](./0005-single-tenant-with-first-class-channels-and-regions.md)'s definition
of a Region. **A Store enumerates the currencies it may price in; a Region selects one and adds tax
and shipping on top; a Price carries its own currency; and kobai models no payment methods at all.**

## This is what ADR-0008 and ADR-0065 already pointed at

Neither record is reversed. ADR-0008 kept a Price as a row so that "a second currency… is one more
row plus one more nullable constraint column, rather than a migration across a catalog, a cart, an
order history and everything reporting on them", and
[ADR-0065](./0065-a-stores-default-currency-is-fixed.md) fixed the **default** while saying in as
many words where multi-currency arrives: as more rows. This is the spec that spends that budget.

What genuinely conflicted was the glossary. `CONTEXT.md` gave a Region "its own currency, tax
treatment, and available payment and shipping methods", which is a second answer to *which
currencies does this Store price in* and a claim about payment methods kobai should not make.

## What is decided

- **The Store enumerates, the Region selects.** Enabled currencies are a Store-level set — the
  vocabulary a Price may be denominated in — and each Region names one of them. Region-only
  ownership was rejected because it makes a currency unusable until somebody defines a geography,
  which is wrong for a single-country Store that simply wants two currencies; Store-only was
  rejected because it discards the entity tax and shipping hang off.
- **The default is still fixed, and ADR-0065's refusal stands.** Its *argument* changes shape and
  that is worth writing down: it rested on "every Price carries the Store's default and no other,
  so moving the column reinterprets each of those amounts", and a Price that names MYR is no longer
  reinterpreted by the default moving. The refusal survives on a narrower base — the default is
  what an **unconstrained** Price is denominated in, so moving it still reinterprets exactly those
  rows. Recorded because a reader finding the old argument no longer load-bearing would otherwise
  conclude the refusal is vestigial and delete it.
- **A Price is asked for by Region, and by nothing else.** `GET /store/variants/{id}/price` takes
  `?region=`, falling back to the Store's default Region — which spec 4 therefore owes. A
  `?currency=` beside it was rejected as two ways to say one thing: currency follows from a Region,
  and so do tax and shipping, so a storefront that asked by currency would have to re-ask by Region
  the moment it needed a shipping quote.
- **A Cart carries its currency, stamped when its Region is set.** ~~Fixed at creation, and
  switching Region means a new Cart.~~ **Amended by #293 — see [the amendment
  below](#amendment-a-cart-switches-region-in-place-293), which is the operative text.** A Cart
  switches Region **in place**, keeping its identifier and every Line Item, and is refused once a
  live Reservation or a Payment is denominated against it. What survives whole is the second half
  of the argument: [ADR-0070](./0070-a-payment-the-shopper-completes-at-their-bank.md) has a hold
  and a PaymentIntent both denominated, and a Cart whose currency could move underneath them is a
  Cart that can be paid for in the wrong one.
- **kobai models no payment methods, and "FPX only for MYR" needs no kobai code.** `CONTEXT.md`
  already refuses the term — the Payment Provider entry lists *"payment method (that is what a
  Shopper chooses)"* under `_Avoid_` — and ADR-0070 chose `automatic_payment_methods` precisely so
  that the PaymentIntent's currency decides which methods are offered. Stripe knows FPX is MYR-only;
  Core does not need to.
- **So a Region's definition loses "available payment methods"** and keeps currency, tax treatment
  and available shipping methods. The two rejected alternatives are worth remembering: a
  `PaymentProvider` that declared its supported currencies confuses the *provider* (`stripe`, which
  takes many) with the *method* (FPX, which does not), and a Region holding a list of method names
  would be a closed set of strings Core promises nothing about — ADR-0014's mistake in a new place.
  A deployment that wants to *restrict* methods configures its provider, in the Project.

## Amendment: a Cart switches Region in place (#293)

**Decided by the maintainer on 2026-08-20 while #291 was in flight, and built in #293.** This
section is the operative text for a Cart; the clause above is struck where the two disagree.

**What this record said:** a Cart's currency and Region are fixed at creation, and switching
Region means a new Cart.

**What it says now:** `PATCH /store/carts/{id}` takes a `regionId`. The Cart keeps its
identifier and every Line Item, is re-denominated in the new Region's currency, and its lines
re-price on the next read. Switching is **refused once a live Reservation or a Payment is
denominated against it**, and the refusal names which.

**Why the first clause did not survive.** *"Repricing one in flight silently changes what
somebody agreed to"* does not hold up against the case. A Cart's Line Items carry **no price
snapshot** — [ADR-0009](./0009-cart-and-order-are-separate-and-orders-snapshot.md)'s deliberate
asymmetry with an Order — so they are already re-priced on every read, and a Shopper who *asks*
to switch is being answered rather than changed under. What "throwing one away is cheap" costs
is paid by somebody else: a Store selling in USD and MYR has Shoppers who switch, and *make a
new Cart* puts the burden of not losing their basket on every storefront that integrates.

**Why the second clause survives whole.** A hold and a PaymentIntent are both denominated.
ADR-0070 has stock claimed and a bank redirect in flight against a Cart totalled in the old
currency, and `place-order`'s `oneCurrency` guard would catch the mismatch only *after* the money
had moved. That guard buys exactly this, at exactly the moment it matters. It **refuses** rather
than releasing the hold, because releasing one by hand is what kobai has decided never to offer
and the sweeper already releases on expiry; and refusing is the direction
[ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md) permits to
be relaxed later, where allowing is not one that can be tightened.

Four things #293 settled in building it, each of which a reader of the clause above would
otherwise have to guess at:

- **Two facts get two words.** A live Reservation is **409 `cart-is-denominated`**; a Payment is
  the **409 `cart-placed`** this route already answers, because Core writes `core_payment` inside
  the transaction that writes the Order (ADR-0009) — so a Cart with a Payment against it *is* a
  Cart that has been placed, and a second word for it would be two spellings of one fact.
- **The guard's limit is named rather than papered over.** The payment ADR-0070 has *in flight*
  is a PaymentIntent the **Project** created, before any Order exists, so kobai holds no row for
  it: what the guard really sees is the **hold** that flow takes first. A Cart whose lines claim
  nothing scarce — a Cart of digital Variants — therefore holds nothing and can still be moved
  with a redirect in flight. Two things bound that and neither is Core's: `@kobai/plugin-stripe`'s
  `charge` compares the intent's amount **and currency** against what Core is about to charge and
  declines a mismatch before confirming, so the money does not move; and a Project that started
  the payment is the only party that knows it did. Closing it inside Core would mean Core
  recording a payment it did not start, which is the pending Order ADR-0070 rejected. **If that
  gap is to be closed, it is a spec about Core learning that a payment is in flight**, not a
  widening of this refusal.
- **The currency is stamped and not read through the Region**, which is this record's own
  duplication and is what the amendment leaves standing: a Merchant may move a Region onto
  another currency, and `core_cart.currency` is what stops that repricing a Cart mid-checkout.
  The Region says *where* and the column says *what in*, and neither is derivable from the other
  once time has passed.
- **A switch that would leave a line unpriceable is refused, naming those lines** — **422
  `variant-not-priced-in-region`**. A Cart moved into a market it cannot be priced in is one
  whose quote and whose placement both refuse, met at the last step rather than at the moment the
  Shopper chose. It is asked of the deployment's own `resolve-price` rather than of `core_price`,
  or a Project that replaced `select-price` would be refused a market it prices perfectly well
  (ADR-0017).
- **Switching to the Region a Cart is already in is not a switch** and is not refused, so a
  storefront may send back the whole state it is holding. That is `PATCH /admin/store`'s
  `defaultCurrency` one noun along.

## Consequences

- **`core_cart` gains a currency column and a Region**, in the three migrations
  [ADR-0038](./0038-widening-a-populated-table-takes-three-migrations.md) requires of a populated
  table — `core_cart` takes a row from every storefront session, so it is the sharpest instance of
  that hazard in Core. The Region is nullable and is *not* backfilled: the Store's default Region
  is seeded at boot rather than by a migration, so at the instant the column arrives there may be
  no Region to name.
- **The price route gains a parameter, which is additive under ADR-0060** — but its behaviour with
  the parameter absent must stay exactly what it is today, or every existing caller is broken by a
  minor.
- **The Store owes a default Region**, or the price route has no fallback and every storefront must
  know a Region identifier before it can render anything.
- **Enabling a currency is not the same as having prices in it.** A Variant with no Price in the
  selected Region's currency has no price, and that is the ordinary `no-price` refusal rather than
  a conversion — kobai converts nothing, ever, which is the whole reason Prices are rows.
