# What "done" means, and the journey that says so

Supersedes the scope clause of [ADR-0024](./0024-one-release-target-v1-and-1-0-are-the-same-thing.md)
and reorders [ADR-0051](./0051-the-commerce-spine-comes-before-the-content-plugin.md). kobai's
release target is no longer "the platform in full". It is **one Shopper journey**, written below,
asserted as a test against the store surface. When every clause of that sentence passes, kobai is
done.

## Why "the platform in full" had to be replaced

ADR-0024 rejected ADR-0021's milestone split because "the release target is what the product
should be, not what one store happens to need". **That argument stands and is not reopened here.**
What it left behind is not a definition: *in full* cannot be checked, so nothing can be measured
against it — and the record shows what that has cost. Three decisions have reordered the roadmap
since: ADR-0051 amended ADR-0029, #170 amended ADR-0051, and this record amends ADR-0051 again.
Each was a local argument about which spec was hardest, taken with no terminus to argue from.

The consequence is in the code rather than only in the record. kobai captures Orders, holds
Reservations atomically, models Fulfilment as its own entity, administers Roles, drives every
admin operation from the Admin and crosses a synthetic major in the upgrade gate — and **the store
surface serves nine operations, not one of which reads a Product**. There is no
`GET /store/products`, no product detail and no variant read. A storefront cannot list a catalog or
render a product page; it can ask the price of a Variant whose identifier it already has.

Nothing noticed for three specs, and the reason is structural rather than an oversight. The admin
surface has a completeness proof — ADR-0010 gives the Admin no private API, so a gap in the API
surfaces as a gap in the Admin, and `tests/admin-uses-only-the-public-api.test.ts` stops it
cheating. The store surface has never had one.

## The bar

**A Developer at an agency can build a client's storefront against kobai's API without writing a
Plugin or patching Core.**

Three bars were available and this is the only one currently false, which is what makes it the one
carrying information.

- **The Merchant's** — every commerce operation reachable in the Admin. That is ADR-0010's
  argument, and #170 satisfied it in full.
- **The Shopper's** — a real person buys a real thing with real money. That is ADR-0021's device,
  and ADR-0024 rejected it as scoping by one store. The rejection stands.
- **The Developer's** — ADR-0007's target segment, and ADR-0002's own claim that "for a Developer
  building a storefront, the API *is* the product".

Its practical virtue is that it names missing routes without anyone arguing feature by feature: a
bar that says *build a product page* produces `GET /store/products`, a description, a handle, Media
and Variant options in one breath, and does not have to be talked into any of them.

## The journey

> A Shopper browses a **Collection**, opens a **product page** and picks an **option**, adds it to
> a **Cart**, has the **stock held**, pays through a **bank redirect**, and the **Order exists once
> the bank has answered** — whether or not the Shopper came back to the tab. The **Merchant
> dispatches** it, and the **Shopper reads it back dispatched**. And **the same purchase completes
> through the hosted Checkout as through a Developer's own**.

That sentence is the definition of done. Every spec below is one clause of it, and a spec is
finished when its clause is in the test and passing — not when its routes exist.

## The instrument, and why it is not a storefront

**There is no reference storefront, and ADR-0002 is untouched.** A gated storefront was considered
at length and rejected: it would have meant amending ADR-0002's "documentation, not a deliverable,
and must never become a constraint on the API", building and maintaining a second SPA, generating
it into `create-kobai`'s template or excusing it in `adaptations.ts` — all to assert things that
are HTTP facts. kobai owns no Shopper pixels and this decision does not give it any.

What plays the Admin's role for the store half is **a journey test in the HTTP seam, driving
`@kobai/client`, under a static ban**:

- **Only the store surface.** After arrangement it may call `/store` and nothing else. No `/admin`,
  no database reads, no Core internals — enforced the way `tests/admin-uses-only-the-public-api.test.ts`
  enforces the Admin's, because a ban nobody checks is a convention.
- **Through the generated client.** ADR-0006 makes `@kobai/client` a deliverable, and what
  exercises it today reaches the wrong half: the Admin drives it against `/admin`, and
  `packages/client/src/client.test.ts` drives it in-process against a handful of routes. **No
  Shopper journey is expressed through it**, and the store surface it can reach is one price
  route — that same file carries a `@ts-expect-error` reading *"there is no such route"* against
  `GET /store/products`. A journey that types cleanly through the client is the first evidence
  that what a TypeScript Developer installs can express a purchase.
- **Arranged however it likes.** `/admin` and the harness are free before the Shopper's session
  begins, exactly as `seedTestCatalog` is. The line falls at the first Shopper request.

This is a weaker instrument than the Admin in one specific way, and the weakness is worth naming:
the Admin is a real client with real needs, and a test is written by somebody who already knows the
workarounds. Two things hold against it. The journey lives **here, as prose**, so each spec's test
is written against the sentence rather than against whatever the routes happen to allow. And it is
**stronger** than a browser for the hardest case on the list — "the webhook arrives and the
Shopper's return never does" is two HTTP calls and one that is never made, which is trivial to
stage here and awkward to stage in a browser.

## The order

| # | Spec | Clause it turns green |
| --- | --- | --- |
| [1](https://github.com/y3owk1n/kobai/issues/207) | **A store surface a storefront can read** — `GET /store/products`, product and variant detail, and the journey test itself | browses, opens a product page |
| [2](https://github.com/y3owk1n/kobai/issues/208) | **Payment that survives a bank redirect** — [ADR-0070](./0070-a-payment-the-shopper-completes-at-their-bank.md), the first-party Stripe Plugin, stock held before the redirect, and the read-only Cart list | has the stock held, pays, the Order exists once the bank has answered |
| [3](https://github.com/y3owk1n/kobai/issues/209) | **Catalog breadth** — description, handle, status, Variant options, Media, Collections, and the repository's filtering convention, which has no honest consumer until they exist | browses a Collection, picks an option |
| [4](https://github.com/y3owk1n/kobai/issues/210) | **Region, Channel and money** — the two entities, the Store's enabled currencies and default Region, Price constraint columns, and a Price asked for by Region ([ADR-0074](./0074-currencies-are-enabled-by-the-store-and-selected-by-the-region.md)) | (none directly — see below) |
| [5](https://github.com/y3owk1n/kobai/issues/211) | **The Order after Capture** — Address ([ADR-0072](./0072-an-address-is-cores-and-validating-one-is-not.md)), shipping selection, the Fulfilment lifecycle, and events (#70) | the Merchant dispatches it, the Shopper reads it back dispatched |
| [6](https://github.com/y3owk1n/kobai/issues/212) | **The hosted Checkout** — [ADR-0073](./0073-the-checkout-is-hosted-optional-and-not-vendored.md) | the same purchase completes through the hosted Checkout as through a Developer's own |
| [7](https://github.com/y3owk1n/kobai/issues/213) | **Tax** — a real `calculate-tax` replacing the zero | (none directly) |
| [8](https://github.com/y3owk1n/kobai/issues/214) | **Manual orders** — [ADR-0071](./0071-a-cart-is-listable-and-a-merchant-may-place-an-order-on-behalf.md): admin Cart routes, `cart:write`, `order:write` | (none directly) |
| [9](https://github.com/y3owk1n/kobai/issues/215) | **Returns and refunds** | (none directly) |
| [10](https://github.com/y3owk1n/kobai/issues/216) | **Content, and #71 with it** | (none directly) |

Each row links to its spec on the tracker. **Payment is second and catalog breadth is third, which
is the ordering most likely to be questioned.** It follows ADR-0029's principle rather than convenience: ADR-0070 reopens what
Capture means, and catalog breadth is work rather than a question. Buying an ugly product page is
survivable; discovering at spec 6 that Capture has to change is not. **Region precedes shipping and
tax** on ADR-0005's own argument — Channel and Region are "nearly free up front and genuinely
agonising to retrofit, because they reach into catalog, pricing, tax, shipping, and inventory
simultaneously" — and three of those five have already shipped without them, so the remaining two
are the last of that budget.

**The Checkout is sixth because it needs an Address to collect and a shipping method to offer**,
both of which arrive in spec 5. It ships showing whatever `calculate-tax` returns, which is zero
until spec 7 — the same figure a Developer's own checkout would be given, so the two agree while
both are wrong, which is the property that matters.

**Five specs turn no clause green, and that is deliberate rather than a gap in the sentence.** The
journey is what a *Shopper* does; Region, tax, manual orders, Returns and content are
Merchant-facing, arithmetic, or a Plugin. Inventing Shopper-visible clauses for them would be
padding the definition to make it look complete. They are in scope because ADR-0028's membership
test says so, and their acceptance is the ordinary one.

## What is out, and "out" means after rather than never

Capacity and its calendar (ADR-0012), bundles (ADR-0027), Translations, customer groups, full-text
search, and ADR-0026's job queue. Two of those need flagging rather than merely listing:

- **Capacity leaves ADR-0018 promising something that will not exist.** That ADR says "one
  interface, two providers", and shipping done with Inventory alone makes the sentence false at
  exactly the moment ADR-0019's semver starts binding. **ADR-0018's wording is owed a correction**
  — an interface with one implementation and a second anticipated — so that the promise matches the
  product. Correcting prose is cheaper than shipping a calendar to make an old sentence true.
- **The job queue may arrive whether or not it is planned.** #70's grill decides whether events are
  durable; if they are, ADR-0026's queue is pulled into spec 5 along with the sweeper debt
  ADR-0057 already owes it. Named here so it is a known risk rather than a mid-spec discovery.

**Shopper accounts and order history are out and stay the Project's.** ADR-0020 has Core store a
Shopper *reference* and no credential, deliberately; nothing here changes it. What changes is that
it is now stated rather than implied, because "my orders" is the feature a Developer will assume is
present and it is not — the journey ends at a Shopper reading back **one** Order they hold the
identifier for.

**All five of ADR-0003's Extension Points must exist.** Two are recorded as *promised only* — events
(#70) and Admin UI slots (#71) — and shipping a defined release with two of five promises
unimplemented would make ADR-0003 false as ADR-0019 starts binding it. #70 lands in spec 5 with
Fulfilment dispatch as its first consumer. #71 keeps its licence to conclude that vendoring is
sufficient, in which case **ADR-0003's list becomes four and says so**, which is a valid outcome
rather than a failure.

## Consequences

- **ADR-0051's "content is next" is superseded; its rule is not.** Content stays *inside* the
  definition — cutting it would cut ADR-0023's thesis, which is far larger than a scoping exercise
  should decide — and sequencing a Plugin last is not the milestone split ADR-0024 rejected.
- **ADR-0029's release gate is untouched** and its argument is now discharged twice: the reference
  Project remains the gate, and the journey is what the gate is asked.
- **The reference Store's default currency becomes MYR.** FPX settles only in MYR and a Store's
  default is fixed (ADR-0065) on a singleton (ADR-0005), so this is what makes spec 2's clause
  assertable. It also stops the currency being decorative: every amount in this repository is USD
  today and no Store priced in anything else has ever been tested.
- **The purchase half of the store surface gains a real client after all.** The journey test is
  written by somebody who knows the workarounds; the hosted Checkout is a client with needs, which
  is the property that makes the Admin a proof under ADR-0010. It reaches only the purchase leg —
  browse and product pages, where the missing routes actually were, stay the test's to defend — so
  this narrows the gap rather than closing it.
- **This record is answerable in the same way the others are.** A spec that ships without its
  clause has not shipped, and the sentence is short enough to hold in mind — which is the whole of
  what "in full" could not do.
