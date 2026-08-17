# Variants are the only sellable thing, and Prices are rows

A **Product** is never sellable. The **Variant** is, and a Product with no options gets
exactly one Variant. Separately, a **Price** is a row — `(Variant, amount, currency)` with
optional Region, Channel, quantity-break and customer-group constraints — resolved by best
match, rather than a column on Variant.

## Why uniform Variants

Models that let a Product be sold *either* directly *or* through Variants (WooCommerce)
produce two code paths in every catalog query, every cart line, every inventory check and
every report, forever. The single-Variant case costs one extra row and one join; the
alternative costs a permanent branch in the domain.

## Why Prices are rows before we need them to be

v1 will insert exactly one Price row per Variant. We are modelling it as rows anyway,
because "add a second currency", "add a sale price", "add a B2B tier" and "add a
Channel-specific price" are all the same shape, and all of them are agonising to retrofit
onto a price column once there is a catalog, a cart, an order history and reporting built
on top of it. The cost of being right early here is one join. The cost of being wrong is a
migration that touches everything.

## Consequences

Price *resolution* is therefore a real operation with real rules, not a field read — which
makes it a Workflow under ADR-0003, and makes its Steps the natural place for pricing
logic Core does not own.
