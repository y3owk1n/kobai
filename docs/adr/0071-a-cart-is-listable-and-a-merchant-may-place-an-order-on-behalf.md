# A Cart is listable, and a Merchant may place an Order on behalf

Extends [ADR-0020](./0020-core-owns-merchant-auth-and-api-keys-but-not-shopper-credentials.md) and
[ADR-0055](./0055-placing-an-order-requires-a-secret-key.md). The admin surface grows Cart routes
and an on-behalf placement, gated by three new Permissions. **The Admin never holds a secret API
key**, and the "nothing to enumerate" clause on `core_cart` is amended rather than quietly broken.

## What this changes, and why it needs saying

`core_cart`'s schema comment reads: *"`id` is the capability… there is deliberately no route that
lists Carts, so there is nothing to enumerate either."* That sentence is load-bearing for ADR-0020 —
a Cart has no Shopper session, so holding its identifier **is** the whole authority to edit its
lines and place its Order. A list route hands that authority out, and a decision written down that
plainly should not be reversed by adding a route and leaving the comment behind.

It is reversed deliberately, for two things a Merchant genuinely cannot do today: see why stock is
unavailable while a Shopper is at their bank ([ADR-0070](./0070-a-payment-the-shopper-completes-at-their-bank.md)),
and take an order over the phone.

## What is decided

- **Carts are listable on the admin surface, with the identifier included.** The capability is no
  longer unenumerable, and the amended rule is: **a Cart identifier is a capability that Merchants
  hold and the public does not.** The route is behind a Merchant session and a Permission, pages
  through ADR-0064's cursor, and filters — `state=live|expired|spent` most usefully, since a Cart
  that became an Order is spent and without that filter the default list is mostly history.
- **Three Permissions, appended last in `PERMISSIONS` with a `--custom` migration granting them to
  `owner`.** `cart:read` for the list and the detail, `cart:write` for creating and editing one,
  and **`order:write`** for placing. That last one corrects a written rationale: `order:read` stood
  alone "only because an Order is immutable, so there is no write for a Permission to gate", and
  placing on behalf is that write arriving. The read/write split is the house rule and is kept.
- **The routes are on `/admin`, and the Admin mints no secret key.** ADR-0055 exists to keep a
  placing credential out of the browser, and the Admin already mints only *publishable* keys for
  its price preview. So `POST /admin/carts`, its line-item routes and `POST /admin/orders` are
  ordinary session-gated admin routes — and `POST /admin/orders` runs the same `place-order`
  Workflow, or an on-behalf Order would quietly skip Reservations, Adjustments and tax.
- **A Merchant's Cart is an ordinary Cart.** Same lifetime, same sweeper, same rules. What a
  Merchant taking a phone order actually needs is the *hold*, which ADR-0070's route already
  provides behind the session gate; a second lifetime rule would mean two kinds of Cart in one
  table and a sweeper that knows nothing about who made a row (ADR-0057).
- **An on-behalf Order takes an arranged payment.** ADR-0056's `received: false` is this flow
  almost word for word — "the honest shape for an invoice, a bank transfer or cash at the counter"
  — so the Order is real, the Payment records that the money has not arrived, and collecting
  happens out of band. **There is deliberately no card entry in the Admin**, which is a PCI
  decision nobody has taken; a payment link is the same async shape as ADR-0070 and costs nothing
  to defer.
- **The Cart list is read-only.** Releasing a hold by hand takes stock from a Shopper who may be
  mid-payment at their bank — ADR-0070's failure mode, caused deliberately — and the sweeper
  already releases on expiry.

## Considered and rejected

- **Return everything except the identifier.** It would have kept ADR-0020's sentence literally
  true and was the original recommendation. It cannot survive on-behalf editing, which needs the
  capability by definition — so the honest move is to amend the rule once rather than to hold a
  weaker version of it and breach it in the next route.
- **Reuse `order:read` for Carts.** Tempting and wrong in the expensive direction: ADR-0009's first
  decision is that a Cart and an Order are governed by opposite rules, and merging their Permissions
  says the opposite in the one place a deployment configures trust.
- **Reuse `catalog:read`.** A Role granted so somebody could edit Products would silently include
  every Shopper's basket.
- **The Admin mints a secret key and uses `/store`.** Least new code, and it is exactly what
  ADR-0055 forbids.

## Consequences

- **"Draft Order" is not the name of this.** There is no draft state: the Order is placed when the
  Merchant places it, and what distinguishes it is who placed it and that its Payment is arranged.
  `CONTEXT.md` refuses the term.
- **`core_cart`'s schema comment must be edited in the same commit as the route**, or the code
  states a rule the API breaks.
- **The Admin gains a section, and the sections list is where it lands** — `lib/sections.ts`, whose
  entries are already narrowed by Permission (#178), so a Role without `cart:read` never sees it.
