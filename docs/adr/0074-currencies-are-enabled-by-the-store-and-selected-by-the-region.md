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
- **A Cart carries its currency, fixed at creation.** Switching Region means a new Cart. Repricing
  one in flight silently changes what somebody agreed to, and a Cart is "mutable, disposable,
  unauthoritative" precisely so that throwing one away is cheap. It also keeps
  [ADR-0070](./0070-a-payment-the-shopper-completes-at-their-bank.md) honest: a hold and a
  PaymentIntent are both denominated, and a Cart whose currency could move underneath them is a
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

## Consequences

- **`core_cart` gains a currency column**, and it is the first thing about a Cart that is fixed at
  creation other than its lifetime.
- **The price route gains a parameter, which is additive under ADR-0060** — but its behaviour with
  the parameter absent must stay exactly what it is today, or every existing caller is broken by a
  minor.
- **The Store owes a default Region**, or the price route has no fallback and every storefront must
  know a Region identifier before it can render anything.
- **Enabling a currency is not the same as having prices in it.** A Variant with no Price in the
  selected Region's currency has no price, and that is the ordinary `no-price` refusal rather than
  a conversion — kobai converts nothing, ever, which is the whole reason Prices are rows.
