# A payment the Shopper completes at their bank

Completes [ADR-0053](./0053-core-owns-the-payment-record-and-ships-no-provider.md) and
[ADR-0056](./0056-a-payment-records-whether-the-money-arrived.md) for redirect payment methods —
FPX, iDEAL, PayPal, a 3-D Secure challenge. **Stock is held before the Shopper leaves, no Order
exists until the bank has answered, and the Shopper's return and the provider's webhook race into
one idempotent placement.** Core's `PaymentProvider` interface does not change.

## What was already decided, and the two holes in it

`packages/core/src/payment/provider.ts` names FPX and describes a flow: the storefront obtains an
authorisation, sends the Shopper to their bank, and calls `POST /store/orders` when they come back,
with `charge` meaning *confirm this and take it*. Its closing rule is that "a placed Order is one
whose payment has been asked for and answered", and ADR-0056 backs it — "there is deliberately no
second value for *pending*, no route that settles one".

**That flow is correct for every method where the money moves after kobai says yes, and FPX is not
one of them.** FPX is a real-time debit rather than an auth-then-capture: the funds leave when the
Shopper authorises at their bank. Two failures follow, and both end with a Shopper out of pocket.

- **Stock.** `hold-reservations` runs *inside* `place-order`, so nothing holds stock while the
  Shopper is away. Pay at the bank, return, and `hold-reservations` refuses `insufficient-stock` —
  money taken, no Order.
- **Abandonment.** The Shopper authorises in their banking app and never returns to the tab, so
  `POST /store/orders` is never called at all. This is the ordinary case in Malaysia, and Stripe's
  own guidance is not to trust the redirect return.

Shipping a payment Plugin that can take a Shopper's money and give them nothing is not a defect a
Project gets to own.

## What is decided

- **Stock is claimable on a Cart before the redirect.** A store route holds every line of a Cart
  and refuses `insufficient-stock`, and `hold-reservations` then **adopts an existing hold rather
  than taking a second**. It sits behind a **secret key** on ADR-0055's argument — holding stock is
  a resource a publishable key in a browser could exhaust, which is the same reasoning that keeps
  placing off the browser's key. The claim is ADR-0018's single conditional update, never a read
  followed by a write, and claim-or-adopt earns a concurrent test in the manner of
  `the-last-unit.test.ts`.
- **No Order exists until the bank has answered.** The Cart is what is allowed to be in flight —
  it is mutable, disposable and unauthoritative by definition (ADR-0009) — so nothing needs a
  pending state, ADR-0009's immutability is untouched, and ADR-0056's record stays a record.
- **The return and the webhook are the same call.** Both invoke `POST /store/orders`, carrying the
  provider's reference in the open context's **body** half (#138) and an `Idempotency-Key` derived
  from that reference. #102 already makes exactly one Order out of two callers racing, so the two
  paths need no coordination and either may be the one that wins.
- **The Project mounts the webhook, not Core and not the Plugin.** A Plugin cannot add a route —
  routes are not one of ADR-0003's five Extension Points — and here that is a feature: the Project
  already forks its own paths for `/admin-ui`, so `/webhooks/stripe` is an ordinary route in
  `reference/src/app.ts` that verifies the signature and calls `POST /store/orders`.
- **A confirmed payment that meets a refused placement is refunded by the Plugin.** A hold can
  lapse while a Shopper is in a banking app, so `insufficient-stock` survives everything above.
  Core answered a refusal and wrote nothing, so Core does not refund: the Plugin made the payment
  and the Plugin reverses it, recording what it did in **its own table** under ADR-0004.
- **The hold's TTL is a Project's, with Core's default.** ADR-0050's precedent exactly — a
  deployment knows its own bank-redirect latency and Core does not.
- **`PaymentOutcome` grows no third variant.** The one its docblock reserves — *send the Shopper
  here, then place the Order again* — is for a Core that starts payments, and here the **Project**
  starts them: the storefront calls a Project route that creates the PaymentIntent with the Cart
  identifier in its metadata. `charge` is therefore still only ever called after the redirect
  completed, and still answers `ok` or `declined`. ADR-0019 puts an interface's shape under semver
  forever, and the variant stays addable later at zero cost to anyone written against today's — so
  adding it unused would be promising a mechanism nobody has designed.

## Considered and rejected

- **Leave it as `provider.ts` describes.** Cheapest, and it keeps both holes.
- **Hold stock but accept abandonment.** Closes the smaller hole. The larger one is the common case.
- **A pending Order settled later.** This is what every commerce platform does and it costs
  ADR-0009: an Order that changes state is an Order that can be rewritten, and the immutability
  that lets a Line Item be a snapshot goes with it. ADR-0056 anticipated the pressure and left the
  door at "a later spec adds its own record beside the Payment; what it must not do is start
  writing to this column" — this decision does not need that door.
- **Core refunds before answering the refusal.** Puts money-moving logic in the one place ADR-0053
  keeps it out of, for an Order that never existed.

## The Stripe Plugin, and the gate

`@kobai/plugin-stripe` integrates through **PaymentIntents with `automatic_payment_methods`** —
one integration covering cards, FPX and GrabPay — with **Elements** in whatever storefront a
Developer builds. Hosted Checkout was rejected: it puts the purchase on pixels kobai does not own
(ADR-0002) and would make the API prove less.

**`devbox run ci` never calls Stripe.** A real call needs a secret, is flaky, and is not
reproducible. The adapter is tested against a stubbed HTTP layer, and the journey runs against a
**fake redirect provider** in `reference/` that exercises the same shape — redirect issued, no
return, webhook settles, hold lapsed. That fake is the more valuable artifact: it is what makes the
abandonment and lapsed-hold paths testable at all, and Stripe's sandbox cannot be made to abandon
on command.

## Consequences

- **The Merchant's account of money that arrived and produced no Order lives in Stripe and in the
  Plugin's table, not in kobai.** That is a named limit of this design rather than an oversight.
  ADR-0056's door stays open if it turns out to be common.
- **This is the first case that genuinely wants Plugin-contributed Admin UI** — the Plugin has
  something to show a Merchant and nowhere in the Admin to show it. That is a data point for #71
  rather than something to solve here; until then it is a Project screen.
- **`hold-reservations` is no longer the only thing that claims stock**, so ADR-0018's "claimed in
  one statement" now has two callers and both are held to it.
- **`@kobai/plugin-stripe` is the second Plugin in this repository that owns tables**, and the
  first that owns them for something Core deliberately does not model.
