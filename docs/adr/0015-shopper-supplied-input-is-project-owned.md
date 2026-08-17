# Shopper-supplied input is Project-owned, and is not Media

Core owns **Media** — Merchant-supplied catalog assets such as product images. Core does
**not** own Shopper-supplied input, such as the artwork a printing customer uploads with an
order. That lives in the Project, in its own table, under ADR-0004's rule that Projects may
add whatever they like.

The two look alike and are not. Merchant media is catalog data: managed, reusable,
long-lived, browsed in the Admin. Shopper input is order data: submitted once, tied to a
single Line Item, and subject to whatever validation that particular business needs.
Building one system for both produces something wrong for each.

## Consequences

Proofing and approval — states, revisions, notifications, rejection — is a human-in-the-loop
workflow, not "upload a file", and is explicitly out of v1. The Merchant proofs out of band
while the Project simply stores the file against the Line Item.
