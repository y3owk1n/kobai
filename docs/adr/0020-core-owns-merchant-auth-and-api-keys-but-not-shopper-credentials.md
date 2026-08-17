# Core owns Merchant auth and API keys, but not Shopper credentials

> **"One Merchant role" superseded by [ADR-0027](./0027-holds-roles-and-bundles-re-decided-on-platform-terms.md).**
> Named roles carrying permission sets are in. Everything else below — Core owning Merchant
> auth and API keys, and not owning Shopper credentials — stands.

Three audiences authenticate against kobai and they are not one system. **Merchant** auth
is Core's, because ADR-0010 makes Core ship the Admin. **API keys** are Core's, following
Stripe's publishable/secret split, scoped. **Shopper credentials are not Core's**: Core
stores a Shopper *reference* — keyed by email, with an optional external identity — and
trusts the identity a storefront asserts over a secret server-side key.

## Why Shoppers are different

kobai is headless (ADR-0002), and a headless storefront almost always brings its own auth —
Clerk, Auth.js, whatever the Developer already uses. Owning Shopper passwords would mean
competing with that choice and losing, or forcing a second identity a Shopper has to
reconcile. Guest checkout is therefore the default path, and password-based Shopper login is
a Plugin if it is ever wanted.

## Consequences

- **One Merchant role in v1.** RBAC for a single-operator store is speculative complexity,
  and permissions are additive rather than structural, so adding them later is cheap.
- Core must never assume a Shopper is authenticated. Every Shopper-facing operation has to
  work for a guest, because for most storefronts it always will be.
