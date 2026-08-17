# The Core membership rule

**Core contains what every store needs *and* what cannot be a Plugin. Everything else is a
Plugin, and first-party Plugins are how kobai ships capability without growing Core.**

The membership test is one question: **does omitting it make the rest of Core wrong?**
Adjustments pass — omit them and "line total" is wrong in every Order, tax base and refund.
Reviews fail — omit them and nothing else in Core becomes incorrect.

## As currently applied

- **Core**: Adjustments, Returns, Translations, tax, shipping, customer groups, webhooks,
  and basic Postgres full-text search.
- **First-party Plugin**: content (ADR-0023), made-to-order, bundles (ADR-0027),
  subscriptions, gift cards, B2B and quotes, advanced search via Meilisearch or Typesense,
  reviews, wishlists, abandoned cart, yield pricing, Shopper auth (ADR-0020).
- **Out**: proofing workflows — one business's process, not a commerce capability.

## Why a rule rather than a list

A list settles today's argument; a rule settles the next twenty. More importantly it
inverts the default: Core growing becomes something a person has to justify against a
written test, rather than the path of least resistance. Every square inch of Core surface
makes ADR-0003's five stability promises more expensive to keep, so the pressure needs to
run the other way by construction.
