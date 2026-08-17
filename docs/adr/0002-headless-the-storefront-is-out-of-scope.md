# Headless: kobai ships no storefront

kobai is headless. It ships an API and an Admin, and it does not ship a storefront — the
Shopper-facing experience belongs entirely to whoever builds it. Recorded because kobai
also claims "best UX in the market", and a future reader will reasonably ask how those two
statements coexist.

They coexist because **UX here means the Merchant's experience of the Admin, not the
Shopper's experience of a store.** kobai cannot compete on Shopper UX, because it does not
own a single pixel a Shopper will ever see.

## Consequences

- Quality bars, design investment, and any "best in market" claim are measured against the
  Admin and against other commerce admin panels — not against storefronts.
- The API is a product surface in its own right, not an implementation detail, because for
  a Developer building a storefront it *is* the product.
- A reference storefront may still be worth shipping as a separate example for
  onboarding, but it is documentation, not a deliverable, and must never become a
  constraint on the API.
