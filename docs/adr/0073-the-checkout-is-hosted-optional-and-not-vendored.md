# The Checkout is hosted, optional, and not vendored

Amends [ADR-0002](./0002-headless-the-storefront-is-out-of-scope.md) and revives a term
`CONTEXT.md` had retired. kobai **optionally** hosts the purchase leg — a **Checkout** that a
storefront hands a Cart to, which collects an Address, offers shipping, takes payment and ends at a
confirmation. It is **off unless a Project turns it on**, it ships as a built asset rather than as
vendored source, and it may use only the public API.

## Why kobai owns these pixels and no others

ADR-0002 stands where it matters: **kobai ships no storefront.** Browse, Collections, product
pages, merchandising and the cart page are the Developer's, and nothing here takes them.

What changed is a finding out of [ADR-0070](./0070-a-payment-the-shopper-completes-at-their-bank.md).
A redirect payment method leaves every Project holding the same four pieces of money-critical work:
a route that creates the authorisation, a signed webhook, an abandonment path where the Shopper
never returns, and a refund when a confirmed payment meets a hold that has lapsed. Each is subtle,
each is wrong by default, and each has the same correct answer everywhere. **A hosted Checkout is
where kobai gets that right once instead of every Project getting it right separately.**

That is a different argument from the one ADR-0002 rejected. ADR-0002 refuses to compete on
*Shopper experience* — merchandising, brand, the shape of a store. The purchase leg is not
experience, it is correctness with a form on top.

## Where it starts and stops

**In:** a storefront hands it a Cart identifier. It collects an Address, offers the shipping
methods the Region allows, takes payment — including the redirect flow of ADR-0070 — and ends at a
confirmation page, with Capture in between.

**Out:** the cart page. That is a merchandising surface — upsells, promotions, the Developer's
brand — and firmly theirs. Also out: everything before it.

The line is where the hard parts live. A narrower Checkout that took payment alone was considered
and rejected: it cannot collect an address, so it cannot compute shipping or tax, so it would hand
back the two hardest inputs and keep only the easy one.

## Why it is not vendored, which is the opposite of the Admin

[ADR-0033](./0033-the-admins-shape-a-vendored-vite-spa-at-a-path.md) vendors the Admin's source
because a Developer must be able to change it, and ADR-0063 spends a great deal on making that
inheritance survivable. **The Checkout is the opposite case and the contrast is deliberate.** It
moves money, it must stay upgradable, and a Project that edited it would inherit exactly the
abandonment and refund paths it exists to spare them — which is the failure this decision was taken
to prevent, arriving through the door marked *customisation*.

So: a built asset in its own package, mounted at a path by the Project, switched on in
`kobai.config.ts`, and themed through **tokens and content slots only** — the Admin's `@theme
inline` precedent, without the source editing.

Two limits are recorded now because both will be asked for and both should be known costs rather
than discoveries:

- **Branding stops where the token layer stops.** A Merchant who needs more builds their own
  purchase leg against the API, which is the supported path and always was.
- **It ships one locale.** Translations are on [ADR-0069](./0069-what-done-means-and-the-journey-that-says-so.md)'s
  out-list, and a hosted Checkout does not get to jump that queue by being Shopper-facing.

## It may use only the public API

The same rule ADR-0010 puts on the Admin, for the same reason and with the same enforcement: no
private route, no `@kobai/core` import, no path `openapi.json` does not carry, checked statically.
A privileged Checkout would be a Checkout that hides gaps in the API instead of finding them — and
finding them is half of why this is worth building.

## Consequences

- **ADR-0002's headline stands and two of its clauses move.** "Does not own a single pixel a
  Shopper will ever see" becomes: owns no *storefront* pixels, and owns the purchase leg only where
  a Project asks. And the quality bar grows a second measurement — a shipped Checkout will be
  compared to Shopify's whether or not this record admits it, and a surface held to no standard is
  worse than one held to a hard one.
- **"Checkout" comes out of Retired terms with exactly one referent.** It names these pages and
  nothing else: the Workflow is still `place-order`, the moment is still Capture, and a storefront's
  own purchase pages are still not kobai's to name. The retirement was about a word meaning three
  things; it now means one.
- **Headless is still the default and still fully supported.** A deployment that never enables it
  is in precisely the world ADR-0002 describes, and the journey test asserts that world first.
- **The purchase half of the store surface gains a real client**, which is the property that makes
  the Admin a proof rather than a demo. It reaches only the purchase leg; browse and product pages
  remain the journey test's to defend.
