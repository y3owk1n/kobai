# A quote is a route, not a total on the Cart

**`POST /store/carts/{id}/quote` answers what a Cart comes to now**, by running the pricing half
of the deployment's own `place-order` declaration — the same `resolve-price`, the same
Adjustments, the same tax Step — and stopping before anything is claimed, charged or written. It
holds nothing, binds nothing, and says when it was asked.
[ADR-0009](./0009-cart-and-order-are-separate-and-orders-snapshot.md)'s refusal to put a total on
the Cart is **untouched**, and this record exists to say why the two are not the same decision.
`@kobai/plugin-stripe`'s `charge` now declines a payment whose amount or currency disagrees with
what Core is about to charge, which is the only reason the route is worth having.

## The hole this closes

[ADR-0070](./0070-a-payment-the-shopper-completes-at-their-bank.md) has the **Project** start the
payment: the storefront calls a Project route that creates a PaymentIntent with the Cart in its
metadata, sends the Shopper to their bank, and `charge` later confirms it. Creating a
PaymentIntent means creating it **for an amount**, and kobai had no amount to give.

`place-order` works out the total at Capture — every line through `resolve-price`, plus each
line's Adjustments, plus the tax on the adjusted figure, plus the Adjustments belonging to no
line and the tax on each of those — and until this ticket nothing else in kobai computed it.
`packages/core/src/cart/read.ts` says why the Cart cannot supply it, in as many words: *"a total
on this shape would be a figure nothing stands behind, and the first thing anybody would mistake
for one."*

So the intent's amount was **the storefront's own arithmetic** over prices it had read, and the
two figures were connected by nothing. `@kobai/plugin-stripe` deliberately did not compare them —
its own source said so — because under that design a mismatch is the *ordinary* case: any Store
with tax or a single Adjustment would have had every purchase declined. The consequence is the
one a commerce engine must not have. A storefront bug, or an intent created before a line
changed, buys an expensive Cart with a cheap payment; Core records the Order at **its** total,
and the Merchant's books balance against money that never arrived.

## Why this is not the total ADR-0009 refuses

ADR-0009's argument is about **where a number lives**, not about whether kobai may state one.

A `total` on the Cart shape is a **field on a mutable, disposable, unauthoritative object**. It
is read as a property of the Cart, it is returned by every route that touches one — creating,
adding a line, changing a quantity — and nothing about it says when it was true or what produced
it. That is the figure nothing stands behind.

A quote is an **answer to a question, asked now**. Four things follow from that and each is a
deliberate part of the shape:

- **It is produced by the same code that charges.** The Steps that ran are the deployment's own,
  and the total is composed by `orderTotalOf` — the very expression `capture-order` writes an
  Order's `total` with, and `take-payment` charges with. There are now three readers of one
  expression rather than a second implementation of the same arithmetic.
- **It says when.** `quotedAt` is on the answer, because the whole of what makes it honest is
  that it was true at a moment.
- **It promises nothing.** There is no deadline on it — a quote that expired would be one that
  was good until it did — and no handle a storefront could present at `POST /store/orders`. Such
  a handle would be the pending Order ADR-0009 refuses, reached from behind.
- **It changes nothing.** No stock is held, no money moves, no row is written. Holding stock is
  still `POST /store/carts/{id}/reservations` (ADR-0070), and a quoted Cart can still be refused
  `insufficient-inventory` when it is placed.

The two rules therefore agree rather than compete, and the docblocks that state the first now
point here so the code does not appear to say a thing the API breaks — the failure
[ADR-0071](./0071-a-cart-is-listable-and-a-merchant-may-place-an-order-on-behalf.md) caught on
`core_cart`'s schema comment and made a rule about.

## What is decided

- **It prices through the deployment's own declaration**, and this is the part that is not
  negotiable. The route is handed the `place-order` value the surface already runs — Core's, or
  the one the Project's config rebuilt — and runs it as far as the tax. A quote computed any
  other way would disagree with the charge **by construction** for any Project that replaced a
  pricing Step, which is this bug in a new place wearing a route's clothes. `place-order.test.ts`
  already holds that a storefront's price and an Order's price come from one declaration; the
  quote joins that guarantee rather than opening a second path.
- **The prefix ends *before* `hold-reservations`, and is named rather than counted.** Everything
  from that Step on claims, charges or writes. Expressing the boundary as a slot rather than as
  "the first four" is what keeps it right for a deployment that inserted a Step into the pricing
  half: an inserted Step sits at a position of its own, so a count would stop the quote short of
  the tax it was asked for. A declaration with no such slot throws, because a quote that ran the
  whole Workflow would charge a Shopper for asking a question.
- **It takes both halves of the open context, and refuses a key that arrived in both.** A
  deployment whose `apply-adjustments` reads a lead time out of ADR-0013's open context must be
  able to quote with the same context it will place with, or the two answer different questions.
  That is why this is a `POST` with a body for a question that changes nothing: the body half
  (#138) cannot travel on a `GET`.
- **It sits behind an ordinary API key**, publishable included, and that is
  [ADR-0055](./0055-placing-an-order-requires-a-secret-key.md)'s reasoning rather than an
  exception to it. The two `/store` routes that demand a secret key demand it because they
  consume something a public credential could exhaust or move — stock, and money. This consumes
  neither, and everything it answers is derived from a Cart whose identifier the browser already
  holds and prices `GET /store/variants/{id}/price` already resolves for a publishable key.
  Gating it would push every cart-summary render through a Project's own server and buy no
  boundary. Under
  [ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md) which
  gate a route sits behind is promised, so tightening this later is a break — it is taken
  deliberately and on the same argument the Cart routes beside it take.
- **`@kobai/plugin-stripe` declines a mismatch.** `charge` compares the intent's `amount` and
  `currency` against what Core is about to charge and refuses if either disagrees, **before** it
  confirms anything. What that ordering buys depends on the flow, and it is worth being exact:
  for a **card** at `requires_confirmation` the money has not moved, so refusing leaves the
  Shopper unbilled rather than billed and refunded; for a **redirect** intent that already
  succeeded the funds left at the bank before kobai heard anything, so refusing cannot unbill
  anybody — what it does is stop the Order being written against money that does not match, and
  giving that money back is the Project's call to `refundUnplacedPayment`, which is the path this
  ADR's parent already describes for a hold that lapsed while the Shopper was away, reached by a
  second cause. Without this half the ticket has only moved the problem.

## Considered and rejected

- **A `total` on the Cart shape.** The cheapest thing to build and the thing ADR-0009 refuses.
  Every route that touches a Cart would return it, and it would be read as a property of the
  Cart rather than as an answer with a time on it.
- **A quote the placement is bound to** — an identifier, a price lock, a "valid until". This is
  a pending Order under another name: something kobai holds, that a placement must be reconciled
  against, that expires. ADR-0009 and ADR-0070 both stand on the Cart being the only thing
  allowed to be in flight.
- **Let the Plugin ask kobai for the Order's total itself.** There is no Order at the moment
  `charge` runs — that is the whole of ADR-0070 — and Core already hands the provider `amount`
  and `currency` on the `PaymentRequest`. What was missing was the figure *before* the redirect,
  which is a storefront's problem and so a route's answer.
- **Have the Plugin start the payment for whatever `place-order` later computes.** Impossible in
  the direction time runs: the intent exists before kobai has seen the placement.
- **A second declared Workflow, `quote-cart`, that a Project wires separately.** It is the
  obvious shape and it is the bug: a Project would have to wire the same pricing customisation
  twice, and the day somebody wired one and not the other the quote and the charge disagree
  silently. ADR-0054's composition exists precisely so that one declaration answers everywhere.

## Consequences

- **A quote is not a hold, and a storefront needs both.** The two routes sit next to each other
  and answer different questions; a Shopper sent to their bank against a quote and no hold can
  still come back to `insufficient-inventory`, which is what ADR-0070's hold route is for.
- **The pricing Steps now run somewhere a *publishable* key reaches, without anything being
  bought.** A Project whose replaced Step is expensive, or which writes something
  (`@kobai/plugin-price-log` records every price resolution), will see it run on quotes as well
  as placements — and a browser's key can ask. That is the price of pricing through one
  declaration and is the right trade: the alternative is two answers. It is also not new in kind,
  since `GET /store/variants/{id}/price` already runs `resolve-price` for the same key; a
  deployment that wants the question rate-limited does it where it already rate-limits that one.
- **A mismatched redirect payment leaves money at the provider and no Order**, and that is a
  named limit rather than an oversight. Core wrote nothing, so Core refunds nothing (ADR-0070),
  and the Project's return-and-webhook route is what calls `refundUnplacedPayment`. What the
  quote route changes is how often that path is reached: it should now be the exceptional case.
- **`orderTotalOf`, `totalOf`, `oneCurrency` and `inWholeMinorUnits` have a second caller.** They
  are exported within Core for that reason, and the agreement between a quote and a placement is
  now a property of there being one expression rather than an assertion that two agree.
- **The Stripe Plugin's known gap is closed**, and the comment recording it is gone. A deployment
  that starts payments for a figure it worked out itself, rather than for the one this route
  answers, will now meet declines it did not meet before — which is the point.
