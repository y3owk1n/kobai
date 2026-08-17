# Placing an Order requires a secret key, and that is a gate rather than a check

`POST /store/orders` and `GET /store/orders/{id}` are open to a **secret** API key and closed
to a publishable one. The refusal is **403** with reason `secret-key-required` — the credential
is live and insufficient — and it is made by a middleware registered in `GATE_REFUSALS`, not by
a handler.

This is the **first behavioural difference between the two key kinds**. Until now they differed
only in how visible they are: both open the store surface, both resolve a price, both build a
Cart, and `kind` was a record of a distinction the key's own prefix already carried. From here
the kinds mean something a Developer has to reason about, so what they mean is written down
before there are storefronts depending on the previous answer.

## Why the kinds have to diverge somewhere

ADR-0020 puts a publishable key in a browser. That is what it is for: a price is what a browser
is allowed to know, and a storefront that had to proxy every catalog read through its own server
would be paying for a boundary that buys nothing. The consequence is that **a publishable key is
public** — it ships in a bundle, it is in the page source, and anybody who wants one has one.

Placing an Order is where money and stock move. A route reachable with a public credential that
consumes inventory is a denial-of-service primitive with a `curl` command for a payload, and one
that takes payment is worse. So the two capabilities cannot sit behind the same credential, and
the split has to land on the route rather than on the surface: `/store` is a storefront's, and
most of it is exactly what a publishable key is for.

Reading an Order back is on the same side of the line, and less obviously. An Order names a
Shopper and what they paid, and its identifier is not a capability the way a Cart's is — a Cart's
identifier is minted for the browser holding it, and an Order's is handed to whatever placed the
Order, which is a server. Serving one to a public credential would make the record's
confidentiality rest on the identifier being unguessable, which is a property nobody promised it.

## What is decided

- **`place-order` and reading an Order require a secret key.** Everything else on `/store` —
  resolving a price, creating a Cart, adding and changing and removing its lines, reading it
  back — keeps working with a publishable one, with the one exception ADR-0020 already made:
  *asserting who the Shopper is* needs a secret key wherever it is done. That is not a leftover:
  it is the storefront pattern ADR-0020 exists to keep working, and the Cart is deliberately on
  the browser's side of the line.
- **403, not 401.** The request carried a live credential and it is not enough. A 401 says
  "authenticate", which invites a storefront to present the same key again, and RFC 6750 would
  have it carry a `WWW-Authenticate` challenge naming a scheme that was already satisfied. The
  reason is `secret-key-required`, so a client branches on the fix rather than on prose.
- **It is a gate, not a check inside a handler.** The requirement is unconditional — no request
  with a publishable key may place an Order, whatever the body says — so it is middleware, built
  through `gateAnswering` and registered in `GATE_REFUSALS`, and `openapi.test.ts` holds both
  directions: a route declaring this 403 must sit behind the gate, and a route behind the gate
  must declare it.
- **It is a second `GATE_REFUSALS` entry, beside `forbidden`.** Two gates answer 403 now and
  they are two different refusals: a Merchant's Role being too narrow, on the admin surface, and
  a browser's key on a store route it may not open. One entry for both would let a route declare
  one and be gated by the other, which is the class of mistake that mechanism exists to catch.
- **The response body names nothing.** `PermissionDenied` carries `required`, the permission the
  Role lacks; there is no equivalent here. A key holds no permissions — it authenticates a
  deployment rather than a person, and carries no Role (ADR-0020) — and what a caller does about
  this refusal is mint the other kind of key, which no field could carry.

## Why not a permission on the key

The obvious alternative is to give an API key a permission set, the way a Role has one, and let a
Merchant decide which keys may place an Order. It is more flexible and it is the wrong shape
twice over.

It contradicts ADR-0020's reason for keeping keys and sessions apart: a Session is a person who
signed in and carries a Role, and a key is a deployment a Developer wired up and carries none.
Putting "which permissions does a storefront hold" on the same axis as "which permissions does a
person hold" is the merge that ADR refused, arriving from the other direction.

And it makes the safe configuration optional. The property worth having is that **a credential
that reaches a browser can never take money**, and a permission set makes that a thing a Merchant
has to get right per key, silently, with the failure visible only in an incident. The kinds
already carry the distinction in the one place it is impossible to miss — a `kobai_pk_` in a
bundle is legible in a code review, a log line and a bug report — so the rule attaches there.

Per-key permissions are additive if a deployment ever needs them, and the reason to want them
would be a *narrower* key rather than a wider one. Nothing here forecloses that; what it
forecloses is a publishable key ever being enough.

## Consequences

- **A storefront needs a server, and only for this.** The browser builds the Cart with its
  publishable key and hands the Cart identifier to the storefront's own backend, which places
  the Order with a secret key it never ships. That is one round trip a Developer has to arrange,
  and it is the arrangement that makes a publishable key safe to publish.
- **Every route added to `/store` from here has to answer this question.** The surface is no
  longer uniform in what a key must be, so a new route names its gate or deliberately does not.
  The description check makes the answer visible rather than assumed, and there is no default: a
  route with no gate is open to both kinds, which is right for a catalog read and wrong for
  anything that writes money or stock.
- **The Cart's `403` and this one are different things, and stay different.** Attaching a Shopper
  to a Cart also needs a secret key (ADR-0020), and that one is answered by a handler because it
  depends on whether the *body* asserts a Shopper — a gate demanding a secret key for every Cart
  write would shut a browser out of building a Cart at all. Both answer 403 and only this one is
  a gate; the two are documented at each other in `http/store.ts` for that reason.
- **`kind` is now load-bearing at runtime.** It was a record of a naming convention; it is a
  branch on the request path. The check reads the column the gate already loaded, so it costs
  nothing, but the column can no longer be treated as descriptive.
