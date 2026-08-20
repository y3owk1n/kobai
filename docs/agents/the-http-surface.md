# The HTTP surface

Core's API contract — how a route is declared, what the description promises, what a refusal may say, and what a rename on it costs — together with the two rules the surface rests on that are not about HTTP at all: how scarcity is claimed, and how a Variant reaches its Fulfilment Strategy. **Read this before touching anything under `packages/core/src/http`, `reservation/` or `fulfilment/`, and before adding a route.**

Part of [`AGENTS.md`](../../AGENTS.md), which is the source of truth and says when to read this.
## Scarcity is claimed in one statement, and the sweeper is a plain interval

**A claim on something scarce is a conditional write, never a read followed by a write**
(ADR-0018). `packages/core/src/reservation/inventory.ts` holds stock with a single
`update … set reserved = reserved + n where on_hand - reserved >= n`, so Postgres takes the row
lock before it evaluates the condition and the loser of a race re-evaluates against the row the
winner left. A `select` and then an `update` cannot do this and no amount of care makes it — the
Store oversells and has merely implemented the appearance of safety, which is worse than none.
The same shape is already how a Cart keeps one line per Variant and how a Cart becomes exactly
one Order; those are unique indexes rather than conditional updates, and both are the ADR's
"a row lock or a unique constraint".

No sequential assertion can see any of this, so **the guardrail is a concurrent test** —
`packages/core/src/reservation/the-last-unit.test.ts`, dispatching many `POST /store/orders` at
one unit of stock. **There are three of them.** The second is
`packages/core/src/reservation/the-variant-that-vanished.test.ts` — the same shape on the path
where no money is involved (#145), dispatching six
`DELETE /admin/variants/{id}` and six `PUT …/inventory` together after the count path was found
reading a Variant in one statement and writing against it in another. The third is
`packages/core/src/reservation/the-cart-that-held-twice.test.ts`, below. How one of those is
written, why each of its assertions is there, and why a green run proves less than you would
think, is in [Writing tests](writing-tests.md) with the other seams; **write the next one the same
way round.**

**Two things claim stock now, and claim-or-adopt is what keeps them from claiming it twice**
(ADR-0070). `POST /store/carts/{id}/reservations` holds a Cart's stock before a storefront sends
a Shopper to their bank — a redirect method takes the money *there*, so a Shopper who returns to
`insufficient-inventory` has already paid — and `hold-reservations` then **adopts** that hold
instead of taking a second. `holdReservations` in `reservation/reservation.ts` is the one
function both go through, and three things about it are decisions rather than implementation:

- **It reports what it *claimed* apart from what the Cart is holding**, and a compensation may
  release only the first. Releasing an adopted hold would take stock from a Cart that still owns
  it, which is the failure the whole design exists to prevent.
- **What is adopted is a hold matching the Cart's claims exactly, and nothing here ever releases
  one.** A partial hold is not adopted — a line added afterwards would be captured against
  nothing — and a hold *larger* than the Cart is not either, because `capture-order` consumes
  every Reservation it is handed. Giving the misfitting hold back and taking a fresh one looks
  right and is not: a placement that adopted it may be between `take-payment` and
  `capture-order`, and releasing its rows fails that Capture **after the money moved**. So a
  changed Cart claims afresh and its stale hold lapses, which costs a Store some unsellable stock
  for one window and costs nobody their money. Adoption looks for the claims *among* what the
  Cart holds for that reason: the next ask adopts rather than claiming a third time. The deadline
  is never pushed out by asking again — how long a hold stands is the deployment's (ADR-0075),
  not something a caller can extend by retrying.
- **The claim-or-adopt decision is a `pg_advisory_xact_lock` per Cart, taken before the read**,
  and that is ADR-0018's *other* answer rather than an exception to it — the same departure
  `the-last-administrator` makes, for the same reason: the condition is about **other rows**, and
  a `select` does not lock those. `core_reservation.cart_id` is what the read asks by, nullable
  because the rows an upgrading deployment already has were written when nothing recorded it.
  The claim on stock underneath is still Inventory's one conditional update.

**A Cart's total is a route and never a field, and it prices through the deployment's own
declaration** (ADR-0077). `POST /store/carts/{id}/quote` answers what a Cart comes to now — lines,
Adjustments, tax — because ADR-0070 has the *Project* create the PaymentIntent and so needs an
amount before kobai has computed anything, and a Cart carries no totals on purpose (ADR-0009).
Four things about it are decisions rather than implementation, and the first is the one to hold:

- **It runs the `place-order` value the surface was handed, sliced at a *named slot*.**
  `quoteCart` in `order/quote-cart.ts` takes the deployment's declaration and runs it up to but
  not including `hold-reservations` — the first Step that claims, charges or writes. A quote
  computed any other way disagrees with the charge by construction for any Project that replaced
  a pricing Step. The boundary is a slot name and never a count, because an inserted Step sits at
  a position of its own and a count would stop the quote short of the tax it was asked for; both
  halves are watched failing in `order/quote-cart.test.ts`.
- **The figure is `orderTotalOf`'s, not a second implementation.** That function and `totalOf`,
  `oneCurrency` and `inWholeMinorUnits` beside it are exported from `place-order.ts` for this one
  caller, so "the quote and the placement agree" is a property of there being one expression.
- **It is a `POST` for a question, and takes both halves of the open context.** A deployment whose
  `apply-adjustments` reads a lead time has to quote with the context it will place with, and the
  body half cannot travel on a `GET` — so it calls `openMetadataWithBody` and refuses
  `metadata-in-both` at 400 exactly as `POST /store/orders` does.
- **It sits behind an ordinary API key**, publishable included, which is ADR-0055's argument
  rather than an exception to it: the secret-key routes consume stock or money and this consumes
  neither. Which gate a route sits behind is promised (ADR-0060), so tightening it later is a
  break.

**The other half of it is in `@kobai/plugin-stripe`**, and without that half the route has only
moved the problem: `charge` compares the intent's amount and currency against what Core is about
to charge and declines a mismatch, **before** it confirms anything.

**One interface, and the providers are Core's own.** `reservation/provider.ts` is ADR-0018's
single Reservation interface; Inventory is its only implementation and Capacity joins
`RESERVATION_PROVIDERS` when it is built. `core_reservation` is Core's record for every provider
alike — `provider` and `subject`, so a Capacity claim needs no column and no table of its own —
and only the provider knows what a subject means. Nothing on the promised surface hands a Project
a way to supply one; that would be a config key and an ADR, and neither exists.

**Consuming happens inside the Capture transaction, and releasing is guarded by the row.** That
is why `hold-reservations` sits before `take-payment` and why `capture-order` declares no
compensation: the database unwinds a claim and an Order together. A release — from the Step's
compensation or from the sweeper — is an
`update core_reservation set released_at = now() where … released_at is null … returning`, and
the rows it actually claims are the only ones whose units go back, so the two can race and the
units are returned exactly once.

**The sweeper is a plain interval and deliberately not ADR-0026's job queue** (ADR-0057) — a
queue brings retry, visibility and failure semantics that deserve their own spec, and the queue
spec will have to migrate this (#98). `packages/core/src/sweep.ts` releases lapsed holds and deletes expired
`core_idempotency_key` rows in the same pass; a Project starts it with `kobai.startSweeper()`
**after** `migrate()`, exactly as it seeds its first Merchant, and `kobai.close()` stops it.
**Test it by winding rows back and calling `kobai.sweep()`** — never by waiting a hold window
out — the way `packages/core/src/sweep.test.ts` does; the one test that waits is the one whose
subject is the timer itself.

**How long a hold stands is the deployment's, not this module's** (ADR-0075).
`reservations.holdWindowMs` in `kobai.config.ts` decides it, fifteen minutes if a Project says
nothing, and `holdReservations` takes the number as an argument rather than reading a constant —
so the store route above takes the deployment's window too, which is what that argument was made
required for. Core keeps a floor of one minute and deliberately **no ceiling**;
that asymmetry with `session.idleWindowMs` is argued on the config key itself. A test that
configures a window boots with the key, exactly as `session` does.

## A Variant points at a Fulfilment Strategy, and never carries a flag

**`requires_shipping` and `tracks_inventory` are questions a Strategy answers, never columns on
a Variant** (ADR-0014). `core_variant.fulfilment_strategy` holds a **name** — `physical`,
`digital`, or whatever a Project wired a Plugin's under — and `packages/core/src/fulfilment/`
holds the interface Core asks. A `check` constraining that column, or an enum in `contract.ts`
listing Core's two, would be the closed set the ADR exists to rule out, in the place it is
hardest to remove.

**It is dependency substitution, not a sixth Extension Point** (ADR-0052). A Plugin *offers* a
Strategy and the Project wires it as `fulfilment: { strategies: { "made-to-order": … } }`, keyed
by the name its Variants point at — so a Strategy has no `name` of its own, exactly as a replaced
Workflow Step is named by the slot it fills. **The key is the name, and there is one of it.**
Building this as anything a Plugin can register into is how the list of five quietly becomes six.

Four things follow, and each is a decision rather than an implementation detail:

- **A Variant may only point at a Strategy the deployment has wired.** `POST /admin/products`
  and `PATCH /admin/variants/{id}` both refuse `unknown-fulfilment-strategy` at 422, naming the
  ones it does have; `place-order` refuses the same reason at 409, which is only reachable by
  *unwiring* a Strategy Variants already point at. Guessing `physical` for an unknown name would
  claim stock nobody asked to claim and record an Order as shipping something that does not ship.
- **A Variant's Strategy is swappable, and the stock count under it never moves** (ADR-0062).
  `PATCH /admin/variants/{id}` is how a poster becomes a download and how a Variant left pointing
  at an unwired Strategy is repaired — the state `place-order`'s 409 exists for, which until #144
  could only be mended by deleting the Product. **Do not make a swap delete the `core_inventory`
  row**: it discards a count a Merchant took, and `consume` is guarded, so it would fail a
  Capture past `take-payment` and refund a Shopper — ADR-0059's argument, reached through an
  update. That is also why no update is refused for a live hold: an update takes nothing away.
- **The answers are asked once per placement and carried.** `load-cart` resolves each line's
  `AppliedFulfilment`; `hold-reservations` reads `tracksInventory` off it and `capture-order`
  snapshots it. A Step that asked again could get a different answer, because a Strategy is asked
  *about a Variant* and may read its `metadata` (ADR-0013).
- **Not tracking Inventory means no claim, not a claim of zero.** The filter lives in
  `inventoryProvider.claimsFor` rather than in the Step, because deciding *which* lines are its
  business is what a provider is for — Capacity will read `hasLeadTime` there in the same place.
  A digital Variant therefore needs no Inventory row, and sells freely even if somebody counted
  it: the Strategy says whether stock is involved and the row only says how many.
- **The wired set is readable, and that is a route rather than a constant** (ADR-0067, #179).
  `GET /admin/fulfilment-strategies` answers every name a Variant may point at — Core's two and
  whatever the Project wired beside them — built from `fulfilmentStrategyNames`, the same helper
  the `unknown-fulfilment-strategy` refusals list the known names with, so the answer and the
  refusal cannot drift. It exists because a client offering a choice had no other honest source:
  hard-coding `physical` and `digital` is the closed set ADR-0014 exists to rule out, moved into
  every client and wrong on the first deployment that wires a Plugin's. **It answers a name and
  nothing else** — the three questions are asked *of a Variant*, so there is no answer to carry
  without one — and it deliberately **does not page**, which was the one departure from ADR-0064
  on the whole surface until `GET /admin/deployment` joined it on the same argument (ADR-0080).

**Fulfilment is its own entity** — `core_fulfilment`, one row per way an Order is delivered,
with `core_order_line_item.fulfilment_id` pointing at it — because one Order has many on
independent timelines and a status column would force one lifecycle onto all of them. The three
answers are **copied onto the row** at Capture (ADR-0009): rewiring a Strategy, or removing the
Plugin that offered one, must not rewrite an Order. Fulfilling anything is a later spec; what
exists is the shape.

**The Strategy from outside Core is `@kobai/plugin-made-to-order`**, and it is the proof
ADR-0014 asked for rather than a feature — *if made-to-order cannot be expressed as a strategy
Plugin, the strategy interface is wrong.* It offers three things and the reference Project wires
all three: a migration set, the Strategy (`requiresShipping`, no Inventory, a Lead Time), and a
Step that fills `place-order`'s `apply-adjustments` slot and turns a requested lead time into an
**Adjustment** on the Order (ADR-0022). That Step reads the lead time out of the **open**
Workflow context — a number Core has never modelled — which closes ADR-0013's scenario end to
end for the first time. Two things about it are worth knowing before extending it: it decides
which lines to surcharge from `line.fulfilment.hasLeadTime` and **never from the Strategy's
name**, because a Strategy is named by the key a Project wired it under and so does not know its
own name; and the open context has **two halves** since #138 — the query string and an optional
`metadata` object on the request body — so its tests place Orders both at
`POST /store/orders?leadTimeDays=3` and with `{ cartId, metadata: { leadTimeDays: 3 } }`, and
the Step reads a lead time spelled either way.

**The two halves merge, and a key arriving in both is refused rather than resolved.**
`openMetadata(url)` is still `Object.fromEntries(url.searchParams)` and is the whole context
for a route that takes no body; a route that runs a Workflow *and* takes one — `POST
/store/orders` is the only one today — calls `openMetadataWithBody(url, body)` instead, which
returns a discriminated union — `{ ok: true, metadata }` or
`{ ok: false, collided }` — so a caller cannot merge and forget to ask. A collision is on the
**key name** and never on the value: `POST /store/orders` refuses it at **400
`metadata-in-both`**, naming every colliding key, before it claims the idempotency key, because
nothing was attempted. There is deliberately no precedence rule, since any of them would be Core
forming an opinion about an input it does not model — and a refusal can still become body-wins
later, where body-wins could never become a refusal. Two consequences for a Step reading the
context: a query value is always a **string** and a body value is whatever JSON it was written
as, so `@kobai/plugin-made-to-order` accepts `3` and `"3"` and nothing else; and **a credential
belongs on the body**, because a query string is written to access logs, proxy logs and the
`Referer` of anything a confirmation page loads. **Capacity is still out of scope** — the
Strategy says only *that* there is a Lead Time, never that a date can be met (ADR-0012).

## The API contract

**A route is a declaration, and the description is generated from it.** Core's HTTP surface
is an `OpenAPIHono` (`@hono/zod-openapi`): each route is a `createRoute({…})` object naming
its path, its security scheme, the body it takes and every status it answers with, and
`app.openapi(route, handler)` both serves it and puts it in the description. So `c.json(body,
status)` is typechecked against the schema the route declared — **a response the description
promises and the handler does not produce fails the build.** Do not add a route with a bare
`app.get(…)`; it would be served and undescribed, and `openapi.test.ts` fails when the
router's table and the description disagree.

**The surface is promised, so a rename on it costs a major** (ADR-0060). kobai's HTTP surface
is under Core's semver commitment — the paths and methods that exist, the fields a request
accepts and a response carries, the status each outcome is answered at, and the `reason` string
inside a refusal. **Renaming or removing any of those is a breaking change rather than a
refactor**, and nothing below can tell you so: the drift checks prove the description matches
the routes, never that the change was allowed. What may still arrive in a minor is additive, and
**ADR-0060's table is what says which** — but one edge of it belongs here, because it is the case
that looks additive and is not: a new `reason`, or a new status, turns an exhaustive `switch`
over a regenerated `@kobai/client` into an incomplete one, so an addition is owed a written note
in the release too. Prose is not promised — a refusal's `error`, a route's `summary` and
`description`, and the description's own serialisation. The licence that makes any of this free
until the first publish is ADR-0058's. Read both before editing `contract.ts`;
`docs/extension-points.md` is where the same promise is written for a Developer.

The schemas live in `packages/core/src/http/contract.ts` and are **structural** — names,
types, presence, closed sets. Rules stay in the module that owns them: whether an address
looks like one, whether a SKU is taken, whether this Store prices in that currency. A rule
that moved into a schema would be one a client could be told about but Core could no longer
change.

**The store surface's catalog shapes are its own, and reusing the admin surface's is the
mistake to watch for** (#207). `StoreProduct`, `StoreProductDetail` and `StoreVariant` are
declared apart from `Product`, `ProductDetail` and `Variant`, and `catalog/store-read.ts` is a
second reader beside `catalog/read.ts` rather than the same one with a flag. The reason is
asymmetric risk: `/store` is opened by a **publishable** key, which is shipped to a browser, so
anything these schemas carry is public — and under ADR-0060 a field added here is promised while
taking one back out is a major. Share the shape and every field a Merchant later needs is
published by the deploy that adds it, with a review as the only thing in the way. What the store
shapes drop, each for its own reason, is beside the fields in `catalog/store-read.ts`:
**`inventory`**, because exact stock is a business fact and ADR-0018 makes availability a
conditional write rather than a readable one; and **`prices`**, because a storefront that read
the rows would pick one itself and bypass `resolve-price`, which is the Workflow that decides and
one a Project may have replaced (ADR-0017) — `GET /store/variants/{id}/price` is the question.
`fulfilment.strategy` and both `metadata` bags are kept. **The two absences are asserted
directly** in `store.test.ts`, against a Variant that really is counted and really is priced,
because a promise about what is *not* in a response is one nothing else notices going missing.
The same split runs through the refusals: `StoreCatalogRefusal` is two words where
`CatalogRefusal` is ten, bound by its own mapped `satisfies`, because a storefront must not be
handed `sku-taken` as something a catalog read might answer.

**A Product is addressed by its id or by its handle, and the resolution rule is held up by a
refusal at the other end** (#251). `GET /store/products/{idOrHandle}` reads a **UUID as an id
and anything else as a handle** — one query, no fallback from one to the other, because the two
spaces do not overlap. What makes them not overlap is that `POST /admin/products` **refuses a
handle that parses as a UUID**, at 400: without that refusal a Product could hold an address by
which it was unreachable, and the rule would be a guess. Three things follow, and each is a
decision rather than an implementation detail:

- **A handle absent from a create is derived from the title and one that is given is taken as
  given** (`catalog/handle.ts`), and **either way a collision is refused rather than suffixed** —
  **409 `handle-taken`**, on `sku-taken`'s distinction: the body is well formed, the Store is
  what refuses it, and it becomes possible again by itself. A Merchant who asked for an address
  and silently got a numbered one would find out from their storefront.
- **A handle that resolves to nothing is the same `product-not-found` a bad id answers.** It is
  one question asked two ways, and a `reason` of its own would be permanent under ADR-0060 and
  buy a storefront a distinction it cannot act on.
- **`PATCH /admin/products/{id}` corrects one, under the same two refusals**, because the
  correction is read by the very narrowing the create is: what could not be created cannot be
  corrected to. There is no `null` for it as there is for `description` — a Product with no
  address is not a state kobai has.

The **backfill** that got this column onto populated tables, and the disambiguation it had to
guarantee, is [migrations](migrations.md)'s subject rather than this file's.

**Two routes over one table are two lists.** `GET /store/products` and `GET /admin/products` page
the same rows in the same order and take **different** `PagedList` names — `store-products` and
`products` — so neither will read the other's cursor. Sharing a name is the most tempting
collision the scheme has, and `pagination.test.ts` has been watched catching it: with both on
`products`, a Merchant's cursor answered a 200 page of the store list. That file's `LISTS` table
also carries **which credential opens each list** now, because the store surface's gate is a
bearer API key rather than a session (ADR-0020) — a store list read with a cookie answers 401,
which looks like an ordinary failure in a file that is not about credentials.

**One schema and two routes are built per instance, and only these.** `Session`'s description
carries the deployment's own session lifetimes, which a Project may set (ADR-0050), so
`contract.sessionSchema(policy)` is a function and `admin.ts`'s two `/admin/session` routes
take the schema it returns. Reach for *that* only for a route whose *description* depends on
how the deployment was configured, and never as a way to make a route's shape conditional: a
description that enumerated different paths per deployment is not a contract.

**`contract.pageQuery(list)` is the other function on this surface, and it is a different
thing** (#183): it builds one schema per **list** rather than per deployment, and what varies
between them is which list's cursors that schema will accept — never which parameters exist or
what they mean. One contract bound once per list is the same contract each time, which is why
this is not the shape the paragraph above rules out.

**A list that also *filters* still names its list once, through the same builder** (#227).
`contract.CartPageQuery` was the first — `GET /admin/carts` takes ADR-0064's `limit` and `after`
unchanged and `state=live|expired|spent` beside them — and `contract.ProductPageQuery` is the
second, with `status=draft|published|archived` on `GET /admin/products` (#252), and
`contract.StoreProductPageQuery` is the third — `collection=` on `GET /store/products`, the first
filter on the **store** surface (#256). All three are **module-level constants**, because a list's
name is the only thing `pageQuery` is a factory *for* and there is one of each list. What such a
schema must not become is one assembled out of the pieces: the whole point of #183's factory is
that one argument settles both ends of a cursor, so anything built here goes through
`pageQueryOf(list, filters)` and adds *filters only*. Everything else on the surface stays a
module-level constant.

**A list may take more than one filter, and they compose rather than choose.** `GET
/admin/products` takes `status` and `collection` together, because each is an
`undefined`-droppable predicate in one `and` rather than a branch — so a Merchant asks for the
drafts in one Collection and is answered by neither list alone. **One filter may be shared
between two lists and is written once**: `collection` is the same optional parameter on both
Product page queries, with a `description` per surface, because what narrowing by a Collection
means to a Merchant and to a storefront are two sentences and the parameter is one.

**The filtering convention is three promises, and they are asserted for every filter at once in
`packages/core/src/http/filtering.test.ts`** (#209, #252):

- **Absent means unfiltered**, which is what made each of these additive.
- **A value outside the set is refused at 400, never ignored** — a filter quietly
  dropped answers a different question from the one that was asked and hands back a page the
  caller reads as the truth. The refusal is `pageQuery`'s existing `invalid`; an unusable
  parameter does not fit the endpoint's schema and needs no `reason` of its own. **From the
  schema where the schema can know, and from the handler where it cannot** (#256): the three
  statuses are a set `contract.ts` holds, and whether a Collection *exists* is a fact about the
  Store — so `unknownCollection` is asked **before the page is read**, in both Product list
  handlers, and answers the same word at the same status. A value that is not even a UUID gets
  that one sentence too, on `IdParam`'s argument: an identifier nothing carries and a string that
  could never be one are the same answer to the caller.
- **A filter composes with the cursor**, and a filtered page being short is still not an
  end-of-list signal — this is the case `nextCursor` was designed for.

That file is **its own** rather than another table in `pagination.test.ts`, and the reason is that
file's argument turned round: the page envelope is the same on every list, and filters are not.
Its table is checked against the description, so **a route declaring a query parameter that is
neither `limit` nor `after` and has no entry reddens the build** — which is what stops the next
filter opting out of the sweep silently. A filter whose values are **not** a closed set fits it,
and `?collection=` is that case (#256): an entry names its own unusable value, and the values it
sweeps are the keys of the arrangement it builds rather than a list in the table, because a
Collection identifier is something the arrangement has just created. Two other things about that
table are #256's and are worth knowing before adding an entry: **`matching` is a map rather than a
partition**, since a Product may be in several Collections and most are in none, so the values
overlap and their union is not the list; and it carries **which credential opens each list**, as
`pagination.test.ts`'s does and for the same reason — a store list read with a cookie answers 401,
which looks like an ordinary failure in a file that is not about credentials.

**A filter is not how a surface hides something.** `status` narrows the *Merchant's* list;
`GET /store/products` and `GET /store/products/{idOrHandle}` answer published Products only, and
that is enforced in `catalog/store-read.ts` rather than offered as a parameter, because a client
that could ask for drafts is a client that will. **`?collection=` on the store surface is not an
exception to that and must not become one**: it narrows to a Collection's membership and sits
beside `IS_PUBLISHED` in the same `and`, so a draft in a Collection is answered by neither the
filtered list nor the whole one. Browsing a Collection is a Shopper choosing what to look at
(story 18); asking for a status would be a client choosing what is visible, which is a different
kind of parameter. A draft answers the same `product-not-found` an
unknown handle does — invisible rather than forbidden, which is also what stops the store surface
leaking that a handle is taken. And **`status` is on `Product` and `ProductDetail` and on neither
store shape**: it is a Merchant's field, so #207's split is what keeps it off a publishable key's
responses, and its absence from both is asserted directly in `store.test.ts` beside `inventory`
and `prices`.

**Invisible and unbuyable are two facts, and shipping only the first is the bug #276 fixed.**
The two Product reads above were the whole of it, so a Shopper holding a `variantId` could read
its price, put it in a Cart and place an Order for a Product no storefront could show. **Every
store-surface route that reaches a Variant now asks whether a Shopper may see it**, and the
guard is in **three** places rather than at each of seven routes — which is the answer to where
such a guard goes, and it is worth reading as a rule rather than as a list:

- **`catalog/store-read.ts` is where `published` is *said*.** `IS_PUBLISHED` guards all three
  catalog reads, `readStoreVariant` joining `core_product` to ask that one question and to
  report none of its fields, and `storeVariantExists` is the same question exported for the two
  callers that need the answer and not the Variant. A second `eq(product.status, …)` written
  anywhere else would be a second statement of what a Shopper may see.
- **`cart/write.ts` asks that question and does not answer it.** `addLineItem` refuses the
  ordinary `variant-not-found`, so adding and reading agree about what exists — a storefront
  that could add a line it cannot render is the failure. It still selects the Variant and never
  the Product, which is what the module's own refusal has always said; what changed is that
  *whether the store surface has such a Variant at all* is now asked of the catalog.
- **`order/load-cart.ts` is the one place the whole Cart path goes through**, and it already
  joined `core_product` for the title, so the mid-checkout case costs one column. `place-order`,
  `POST /store/carts/{id}/reservations` and `POST /store/carts/{id}/quote` all read a Cart
  through it, and all three therefore refuse **409 `variant-unavailable`**, naming the Variant
  by SKU.
- **`resolve-price` is deliberately *not* guarded.** It prices a Variant; it does not decide who
  may see one. That is what makes the store price route's guard the route's own, and what leaves
  `GET /admin/variants/{id}/price` able to preview a draft's price through the same declaration.

**A Cart line whose Product left the storefront is refused, not dropped**, and the cost is
accepted rather than avoided: a Shopper who did nothing wrong meets a dead end at the last step.
Dropping the line silently changes what is being bought (ADR-0009's snapshot argument read
forwards), so this is ADR-0059's refuse-rather-than-cascade with a repair the Shopper can carry
out — remove that Line Item and the rest of the Cart places. **One word for draft and archived
alike**, because a storefront can act on neither differently and the surface publishes no status.

**Two refusals on this path carry no `workflow`, and that is why `PriceRefusal`'s is optional.**
The store price route turns a hidden Variant back *before* `resolve-price` runs, so a
`variant-not-found` there reports no run — exactly as `PlaceOrderRefusal` already answers an
idempotency refusal. It also means the store surface answers **identically** for a Variant that
never existed and one a Shopper may not see, which is `product-not-found`'s property one noun
along: a client that could tell the two apart could enumerate what a Merchant is preparing.

**`GET /admin/variants/{id}/price` is the deliberate way through, and it is not a privileged
route.** Previewing an unpublished Product's price is the *feature* — it is how a Merchant checks
what a replaced pricing Step will do before putting something on sale — so closing the store
surface uniformly would have taken a capability away to fix a hole somewhere else. It sits behind
**`catalog:read`**, runs the deployment's own `resolve-price` (never a second implementation of
pricing) and answers `ResolvedPrice`, `workflow.steps` included. ADR-0010 is untouched: the Admin
still uses only the public API, and what changed is that the public API now answers a question
the store surface cannot answer honestly. `catalog/a-draft-product-is-not-buyable.test.ts` holds
the two routes to answering **byte for byte identically** for a Product that is on sale, because
a preview that could disagree with the storefront is worse than no preview.

**`http/workflow-refusal.ts` is where a refusing run becomes a response**, for both surfaces:
the body, the `statusMapper` each surface builds its own maps with, and the one map that *is*
shared — price resolution's, which is the same two words wherever it is asked. The quote's and
the placement's maps stay in `store.ts`, because those are routes only that surface has and a
shared table would infer a status union covering routes that can never answer half of it.

**A Product declares its options and a Variant names its value for each, and the pair is the
whole picker** (#253). `ProductDetail` and `StoreProductDetail` carry the options **in the order
the Merchant declared them**; `Variant` and `StoreVariant` carry a value for each, in that same
order. Seven things about it are decisions rather than implementation:

- **There is no route that takes a combination and answers a Variant, and that is the decision.**
  The detail payload already settles it — a storefront zips the two lists and a combination no
  Variant answers is `undefined` rather than a refusal to interpret, which is story 21 falling out
  of the shape. A route would be a second answer to a settled question, and one that could
  disagree. `catalog/options.test.ts` writes that mapping out once and runs it against what
  `/store` really answered, which is the closest a test gets to being the storefront.
- **Options are declared with the Product and corrected on it.** They are in `POST
  /admin/products`'s body and are written in the same transaction as the Product and its Variants,
  so a Variant naming an option its Product has not declared is not a state that exists for an
  instant. `PATCH /admin/products/{id}` takes `options` as **the whole list, in the order it should
  end up in**: an entry carrying an `id` is the option that already has it — renamed, moved, or
  both, with its Variants' values still attached — one without is new, and one the Product has that
  the list does not name is removed with every value for it. **Identity on the wire is what makes a
  rename a rename**; reconciling by name instead was watched taking every value with it.
- **One word, one status, three routes.** A Variant whose values are not exactly its Product's
  declared options is refused **422 `variant-options-mismatch`** at the create, at `POST
  /admin/products/{id}/variants` and at `PATCH /admin/variants/{id}` alike, naming what it left
  unanswered and what it named that was never declared. It is one fact about a Variant and its
  Product, and where the Product happens to have been declared in the same body changes neither
  what is wrong nor how it is fixed — the argument `unknown-fulfilment-strategy` already makes for
  saying one thing in one way.
- **Adding an option leaves the Variants under it unanswered, deliberately.** Judging them at the
  Product's `PATCH` would refuse the correction for every Variant at once, and the only way out
  would be to rebuild the Product — a refusal whose advice names no reachable control, which this
  file says is a finding rather than something to word around. So the short list reads back
  truthfully and `PATCH /admin/variants/{id}` is the repair, which is also why an absent `options`
  there still means "leave it": the *route* leaves a Variant left short correctable in its other
  fields. The Admin's Variant form does send them every time and so does ask for the missing
  value — that is a decision about the form rather than about the route, and
  [the Admin](the-admin.md) is where it is argued.
- **No two Variants of one Product may answer its options the same way** (#277), and the whole
  of the payload above rests on it: a storefront maps a chosen combination to a SKU by itself,
  and where two Variants share a combination that mapping is not a **function** — the picker
  takes whichever it met first, and there is no route to fall back on because #253 deliberately
  shipped none. The unique index is `(variant_id, option_id)`, which makes a Variant's answer to
  one option single and says nothing whatever about two Variants agreeing on every option, so
  the rule is code rather than a constraint: `catalog/options.ts`'s `combinationTaken`, asked
  at **409 `variant-combination-taken`** by `POST /admin/products/{id}/variants` and `PATCH
  /admin/variants/{id}` alike — `sku-taken`'s status for `sku-taken`'s reason, a combination
  being what identifies a Variant *within its Product* as a SKU identifies one within the Store.
  A **create** naming one combination twice in its own `variants` is `invalid` at 400 instead,
  which is the line that list already draws for a SKU named twice: a body conflicting with
  itself is not the Store refusing anything, and no retry of it as it stands will be taken. Four
  things follow, and each is a decision:
  - **A Variant is not its own sibling.** Re-sending the combination it already answers, which
    is what a form does on every submit, is the Variant answering it rather than a collision.
  - **Only a Variant that answers *every* declared option answers a combination at all**, so
    one left short by an option added since is compared with nothing — it is unplaceable by a
    picker rather than ambiguous with anything.
  - **A Product declaring no options is not judged**, and that is the deliberate boundary: it
    offers no combination to choose, so its Variants are told apart by their SKUs exactly as
    they always have been, and several under one Product stay ordinary.
  - **The lock is `lockProductOptions`, and the three writes take the same key on purpose.**
    The fact is spread over one row per option, so no unique index can hold it and the check is
    a `select` over other rows followed by an `insert` — ADR-0018's forbidden shape, which
    `lockProduct` cannot fix because `for share` holders do not conflict.
    `catalog/two-variants-of-one-combination.test.ts` is the concurrent test and it was watched
    failing: eight adds of one combination, three of them 201.
- **A correction to a Product's option list that would collide two Variants is refused, naming
  them** (#277's ruling) — the same word at the same status, from `PATCH /admin/products/{id}`,
  because it is one fact reached from another end. Removing an option takes every Variant's
  answer to it, so two that differed only there answer one combination afterwards. **This does
  not reopen the decision above it**, and the pair is worth reading together: adding an option is
  *not* refused because the only repair would be to rebuild the Product, and removing one *is*
  because the repair is a control the Merchant already has — correct or delete one of the two
  Variants named, and send the correction again. The difference is precisely whether a reachable
  repair exists, which is also ADR-0059's test. Three things follow:
  - **The ruling says "newly" collide and the check does not ask, because nothing can tell the
    two apart.** Every write path above refuses a collision, so a Product that holds one is a
    Product no request could have produced — meaning "would newly collide" and "would leave
    colliding" name the same set of corrections. Asking the question twice, before and after,
    would be a branch no request can reach and no test can arrange. **The day rows written
    before this rule exist** — by hand, or by a deployment older than it — that stops being
    true, and such a Product's option list cannot be corrected at all until one of the pair is
    repaired. That is the point at which asking "newly" earns its keep.
  - **A rename or a reorder collides nothing**, because identity on the wire is the `id`: the
    combinations either side of the correction are the same combinations.
  - **A correction that leaves the Product declaring nothing is not judged**, and neither is one
    that adds an option while removing another. Both fall out of the boundary above rather than
    excepting it — the first leaves a Product with no combinations to share, the second leaves
    every Variant unanswered — and both are asserted in `catalog/options.test.ts` rather than
    left to be inferred.
- **The store shape drops the option's identifier and nothing else.** A storefront addresses
  nothing by it — both lists are keyed by **name**, unique within a Product — and it exists so a
  Merchant can rename one without losing its values. `StoreProductOption` and
  `StoreVariantOptionValue` are declared apart from their admin twins for `StoreVariantFulfilment`'s
  reason, though `StoreVariantOptionValue` happens to carry the same two fields.

**Media is a record here and bytes somewhere else, and where the bytes come from is the
surface's one open route** (#254, ADR-0015). `POST /admin/media` is the surface's **first and
only binary request** — `multipart/form-data`, described honestly as `type: string, format:
binary`, answering JSON typechecked against `contract.Media` like every other route — and it sits
behind `catalog:write` because Media *is* catalog data, with `GET /admin/media` behind
`catalog:read`. Five things about it are decisions rather than implementation:

- **`GET /media/{key}` is open, and it is the only route on this surface no credential opens
  besides `/health`.** An `<img>` sends no header, so a gate there would serve nothing to the
  thing the route exists for — which means the question was never how to gate it but whether
  kobai serves image bytes at all. It does, for one reason: the `MediaStorage` Core ships writes
  files to a directory, and a file on a disk is reachable over HTTP by nothing. `openapi.test.ts`
  names the three open operations in `OPEN_OPERATIONS` rather than inferring them from an
  absence, so **a fourth entry there is a new open route and a thing to weigh.**
- **The address is the storage's answer, asked at read time, and there is no `url` column.** A
  deployment behind a CDN answers `https://…` on every Media and no image byte passes through the
  application; `filesystemMediaStorage` answers `/media/{key}` and kobai serves those. So the
  `url` on the wire may be absolute or root-relative and a client has to render both — and a
  Store that puts a CDN in front of the bucket it already had changes one line of
  `kobai.config.ts` rather than rewriting a table. `MediaStorage.read` answering `null` is the
  other half: it means *not kobai's to serve*, and the byte route says `media-not-found` to
  anyone who asks anyway.
- **The bytes are served as the content type the *row* holds, with `nosniff`.** The upload
  declared it and nothing since has been in a position to know better, and a browser guessing
  `text/html` about a file a Merchant uploaded would be a stored script on the Store's own origin.
- **`width` and `height` are read out of the file's header** (`media/dimensions.ts`) and are
  `null` for a format kobai cannot read one from. Taking them as fields on the upload was the
  alternative and is worse: a storefront would be laying out against a claim. Resizing,
  converting and thumbnails stay out of scope — a Project that wants derivatives puts a CDN in
  front.
- **The byte route's refusal is not a family and the upload's now is.** `MediaNotFound` carries a
  single literal, on `ApiKeyNotFound`'s shape, and **attaching** one added that literal's word to
  `CatalogRefusal` and no family beside it (#255) — one fact gets one word, whichever end it is
  asked from. **Uploading** refused `invalid` alone through `InvalidRequest` until #278 gave it a
  second and third word, at which point it became `MediaUploadRefusal`: `refused` answers with
  one body type across every status a route names, so a 400 and a 422 on one route have to be
  one schema. Nothing about Media is still refused by the *state* of the Store — an asset
  conflicts with nothing and takes no name anybody else could hold.

**An upload has a ceiling and a list of content types it will take, and both are the Project's**
(#278). `media: { maxBytes, accept }` sit beside `media: { storage }` in `kobai.config.ts` —
ADR-0050's shape, with Core defaulting to ten mebibytes and the five raster image types — and a
value Core will not enforce stops the boot rather than being clamped, exactly as
`session.idleWindowMs` and `reservations.holdWindowMs` do. Five things about it are decisions
rather than implementation:

- **The size is judged twice and the ordering is the point.** Reading the declared
  `Content-Length` is cheap and lies; measuring the bytes is honest and means having buffered
  them, which is the cost the ceiling exists to bound — and neither half resolves the other. So
  `refuseDeclaredSize` runs as **route middleware, ahead of the body validator**, because the
  multipart parser is where the memory goes and nothing behind it can prevent a spike; and
  `uploadMedia` then measures what it really has, which is the half that decides. The cheap one
  allows a fixed envelope slack on top of `maxBytes` and **must never refuse something the
  honest one would take** — a multipart body is bigger than the file inside it, so an exact
  comparison there would turn back a file of precisely the ceiling. What neither can do is
  bound a client that lies or sends no length at all: that needs a streaming multipart parser,
  and until there is one those bytes are buffered before they are refused.
- **That middleware is deliberately not a gate.** `GATE_REFUSALS` exists for a refusal *no
  handler makes*, which is what makes a route declaring one a claim about its chain. This one
  answers the same status, word and body the handler answers a moment later, from the same
  function — so nothing is promised that only a middleware produces, and deleting it changes
  when the refusal is made and not whether.
- **Both refusals are made before `MediaStorage.put`, and that is ADR-0078 read forwards.** The
  interface has no `remove`, so a refusal arriving after the write leaves bytes no route in
  kobai can delete. Every check that can be asked of what is already in memory is asked there.
- **Two words rather than one** — `media-too-large` and `content-type-not-accepted`, both at
  **422**, on `unknown-fulfilment-strategy`'s distinction: well formed, and refused by what this
  deployment declared. They are two because they are two repairs (export it smaller; export it
  as something else), and 413 and 415 were rejected — this surface answers from a small
  vocabulary of statuses and a client branches on the `reason`, and a 413 is also what the
  reverse proxy in front of kobai answers with its own HTML body.
- **The route is built per instance, for `sessionSchema`'s reason**, so its description carries
  *this deployment's* ceiling and list; and **`image/svg+xml` is not in Core's default**, because
  an SVG may carry script and `GET /media/{key}` is open and same-origin. Widening later is
  additive and narrowing later would be a break (ADR-0060), which points the same way the
  security argument does.

**Media is attached to a Product and to a Variant, and attaching is a list rather than a route**
(#255, ADR-0082). `media` on `PATCH /admin/products/{id}` and on `PATCH /admin/variants/{id}` is
the whole list of what that subject shows, in the order it should be shown in — so attaching,
reordering and detaching are one field, an empty list detaches everything, and there is
deliberately no `POST …/media` or `DELETE …/media/{mediaId}` beside them. That is `options`'
bargain one noun along and it is taken for the same reason. Five things about it are decisions
rather than implementation:

- **Two join tables, `core_product_media` and `core_variant_media`, and never one polymorphic
  one.** A single table with a `subject_type` and a nullable target is the shape a foreign key
  cannot constrain, which is the whole reason Core's tables are relational rather than a bag
  (ADR-0004) — and `metadata` is the escape hatch, deliberately not this. The cost is the same
  four columns twice; what it buys is `on delete cascade` stating "a deleted Product takes its
  attachments" in the database rather than in a function somebody has to remember to call.
- **What becomes of a Media nothing references is ADR-0082, and the answer is nothing at all.**
  Detaching removes the attachment; the row and the bytes stay, and no cascade, sweep or route
  deletes either. Both `media_id` columns are `on delete restrict`, which is ADR-0059's rule
  held by Postgres — so the delete route, when somebody writes one, is refused-while-attached by
  construction and its repair (detach) already exists. **`MediaStorage` still has no `remove`**,
  and adding one is a break for implementers that belongs to that ticket.
- **`media` is on the correction and not on the create**, on either surface. The bytes go up at a
  route of their own and that route answers an identifier, so attaching is a second act however
  the surface is shaped — where a Product's `options` are in the create precisely so that a
  Variant naming an undeclared option never exists for an instant. There is no such state here.
  **`collections` is not the same absence and reached the create in #280**, which is argued where
  membership is — do not read the two as one rule.
- **A Variant's list does not extend its Product's and is not extended by it.** A storefront gets
  both and decides; a kobai that copied one into the other would have taken that decision and
  left no way to tell an inherited picture from an attached one.
- **`StoreMedia` is declared apart from `Media` and drops `filename`, `contentType` and
  `byteSize`** — #207's split, and here it does real work: those three are about the *file*
  rather than the picture, and two of them are facts the thing fetching the bytes is told by the
  response that carries them. `catalog/store-read.ts`'s `asStoreMedia` names the five fields that
  are published, field by field rather than by omission, so the next field added to `Media` for a
  Merchant reaches a browser only by somebody editing that function.

**A Collection groups Products, and it is Core's rather than the content Plugin's** (#256,
ADR-0074). The *grouping* is a catalog relationship — it is what both Product lists narrow by —
while the **page** that renders a Collection is content and belongs to #216; splitting it the
other way would have left `?collection=` a filter Core could not implement without reading a
Plugin's tables, which ADR-0004 forbids in both directions. `POST`/`GET`/`PATCH`/`DELETE
/admin/collections` are the five routes, behind **`catalog:write` and `catalog:read`** and no
`collection:` family of its own: a Merchant who may write the catalog may group it, which is
`role:write`'s argument (ADR-0066) at a different table, and it means an upgrading deployment
gets the routes working rather than a Permission nobody holds. Five things about it are decisions
rather than implementation:

- **Deleting a Collection ungroups its Products and deletes none of them** (story 17), and it is
  the **one catalog deletion that refuses nothing**. `DELETE /admin/products/{id}` refuses while
  stock is reserved and `DELETE /admin/roles/{id}` refuses while Merchants hold the Role, because
  both take something away from somebody (ADR-0059); this takes away a *label*. So
  `core_product_collection.collection_id` is `on delete cascade` — reaching the join row and
  stopping — where `core_product_media.media_id` is `restrict`, and the two opposite judgements
  are the same rule read from two sides. Refusing here would mean emptying a Collection before it
  could be removed, which is tidying up in order to delete a name.
- **Membership is a whole set, on `POST /admin/products` and on `PATCH /admin/products/{id}`, and
  nowhere else.** `collections` is `media`'s bargain one noun along, taken for half of `media`'s
  reason: a list of edits leaves no way to say *and this one is gone*. The other half does **not**
  carry — a Product's images are shown in an order a Merchant chose and a Product's Collections
  are a **set**, so there is no `position`, the order of the array means nothing on the way in,
  and a read answers by title. There is deliberately no `products` on
  `PATCH /admin/collections/{id}`: two fields writing one fact would be permanent under ADR-0060
  and could disagree about what an empty list means. **It reached the create in #280 and `media`
  did not**, which is the pair worth reading together: the two absences read alike and are not
  the same thing. Media is bytes that go up at a route of their own and come back as an
  identifier, so attaching is a second act however the create is shaped; a Collection is a row
  that already exists, so the field costs nothing but itself and saves a client creating a
  hundred Products into one a hundred requests. Absent and empty are one fact at the create — a
  Product is in nothing until somebody groups it — and two at the correction, where absent means
  "leave it" (ADR-0062). One reading (`parseCollectionMemberships`), one word, one status at both
  ends.
- **A Collection has no handle and no unique title, and both absences are decisions.** Nothing
  resolves one by name — a storefront browses one through `?collection=`, by the `id` the Product
  it was already holding reports — so a second unique string would be ADR-0038's whole dance taken
  for a route that does not exist. The address a Collection is *published* at belongs to the page
  that renders it. And a title identifies nothing, which is exactly what `core_role.name`'s
  uniqueness rests on and this has not got: a Merchant is created *against a Role by name*.
- **`collection-not-found` is one word for one fact, whichever end asks.** It is
  `CollectionRefusal`'s and `CatalogRefusal`'s alike — 404 from the Collection routes, **422**
  from a `collections` list naming an asset the Store has not got, on `media-not-found`'s
  distinction — and it is asked before the *first* write either route makes, for #255's reason: a refusal
  returned from inside a transaction commits it.
- **`StoreProduct` carries its Collections and there is no `GET /store/collections`.** A
  storefront renders breadcrumbs, and links a catalog tile at what it belongs to, from the Product
  it already has — on the list shape as well as the detail, so a grid is one request. `StoreCollection`
  is declared apart from `Collection` for `StoreMedia`'s reason though it drops nothing today, and
  `asStoreCollections` names the published fields one by one. Nothing on that surface enumerates
  Collections; adding a route is additive under ADR-0060 the day something needs one.

**Drift fails the build, in two places.** `packages/core/openapi.json` and
`packages/client/src/schema.ts` are both generated and both checked in.
`packages/core/src/http/openapi.test.ts` regenerates the description and compares;
`packages/client/src/schema.test.ts` regenerates the client and compares. Both run under
`pnpm run ci`. Regenerate with `pnpm run openapi:generate` — Core first, then the client,
because pnpm walks the workspace in dependency order.

**A third check covers the one file in `@kobai/client` nothing generates** (#196).
`packages/client/src/index.ts` re-exports each schema by name so that a name leaving the API
is a build failure there rather than a `never` downstream — and being hand-written, it went
stale in the other direction, twice over: **#196 found five of twelve refusal families named,
and by the time it was answered six of sixteen were unnamed** — the rest reached through
`components["schemas"][…]`, which works, narrows identically, and is exactly the indirection
the by-name exports exist to remove. Neither drift check above can see that,
because `components` carries every schema whether or not a name is taken off it. So
`packages/client/src/refusals.test.ts` reads every **refusal family** out of the description —
structurally, as any schema requiring both `error` and `reason`, never as a list of names —
and fails naming any the client omits or exports under some other name. **Adding a refusal
family to Core is therefore one line in `index.ts` too**, and the build says so. The two
families whose `reason` is an **open string** are still exported like the rest and carry the
reason they cannot be narrowed exhaustively in their own doc comments, because a consumer
meets the name and not this file.

**A version bump in `packages/core/package.json` drifts the description too** (#158). `info.version`
is `coreVersion()` in `http/app.ts`, read from Core's own manifest when the document is built,
because ADR-0060 makes the surface's version the package's — one fact, not a second copy kept by
hand. The checked-in artifact only moves when somebody regenerates it, so **bumping the version
without running `pnpm run openapi:generate` fails `openapi.test.ts` twice**: once as a byte
diff, once as an assertion naming both versions. The asymmetry is the part that surprises people
and it is verified rather than assumed — **`packages/client/src/schema.ts` does not move**,
because `openapi-typescript` emits paths, components and operations and never the `info` block,
so a regenerated client is byte-identical across a version bump.

**Every list route pages, and there is one way to do it** (ADR-0064). `?limit=` and `?after=`,
an **opaque** `nextCursor` beside the items, no offset and no total — on every list that exists
and on every one added after them, because a surface where some lists page and others do not is
one a client has to learn twice. A new list route therefore takes
`request: { query: contract.pageQuery("<its own list>") }`, declares `400: PAGE_QUERY_INVALID`,
answers with `{ …items, nextCursor: page.nextCursor }`, and reads its page through
`packages/core/src/db/page.ts`. Seven things about it are decisions rather than implementation:

- **`nextCursor` is absent on the last page and that is the only end-of-list signal.** A short
  page is not one — a filtered page can be short and not last — so a reader fetches `limit + 1`
  rows through `pageSize`/`takePage` and reports a cursor exactly when the extra row exists. A
  count would be a second query over the whole table to answer a question with two answers.
- **The ordering ends in `id`, and the cursor is the same pair.** #132 already paid for a tie
  once, where it made the upgrade gate red *sometimes*; at a page boundary a tie skips or
  repeats a row instead of merely reordering it.
- **Every table a list pages carries a `(created_at, id)` index, and a sweep says so** (#219).
  Ascending though every reader wants descending, because one ordering reversed whole is a
  backwards scan of the same index. It used to be a convention: `0028` indexed the three tables
  that paged when it was written, #173's `roles` and `merchants` then shipped without one from
  an ordinary declaration and a green gate, and ADR-0064's own argument — that the query stays
  on an index rather than sorting the table — was the clause nothing checked. `db/schema.test.ts`
  checks it now, over a `Record<PagedList, …>` so that a list added without one is a **compile
  error** rather than a silent exemption, and it asks `indexesOf` rather than
  `indexedColumnsOf` because the flattened answer cannot tell a composite index from two
  single-column ones that cover the same two names — nor, without the direction and the `where`
  clause that inspector also reports, from the pair declared `desc` or an index over part of the
  table. **Declaring the index in `schema.ts` is therefore part of adding a list route**, and
  a plain `CREATE INDEX` is not ADR-0038's hazard — see [migrations](migrations.md).
- **The cursor carries the timestamp as Postgres's own text, never a `Date`.** A `Date` holds
  milliseconds and `now()` holds microseconds, so a cursor round-tripped through one would fall
  on the wrong side of its own comparison and hide every row sharing that millisecond. That is
  why each paged query selects `cursorAt(column)` beside the `created_at` its response reports:
  two readings of one column, because the wire wants an ISO string a person reads and the
  cursor wants what the database is ordering by.
- **A `limit` over the ceiling is refused, never clamped**, and an `after` that does not decode
  is refused too — both as the existing `invalid` at 400, from `pageQuery` itself, because an
  unusable parameter does not fit the endpoint's schema and needs no `reason` of its own. A
  caller that asked for 5,000 and received a hundred would read the short page as the end.
- **A cursor names the list that issued it, and no other list will read it** (#183, ADR-0064).
  That is the whole reason `contract.pageQuery` is a **factory**: the name a route passes it is
  both what `decodeCursor` will accept and — travelling to the reader on the `PageRequest`
  itself, never as an argument of its own — what `takePage` stamps into the next cursor, so one
  call decides both ends and there is no second place to keep in step. `PagedList` in
  `db/page.ts` is the closed set of those names, and a **collision** in it is the one failure
  left — two lists sharing a name would trade cursors exactly as an unbound cursor did, and no
  type can see that, because a union absorbs a repeated member in silence. What sees it is
  `pagination.test.ts`, in the two cases below that only work together. A cursor from elsewhere is refused as the same `invalid`, deliberately —
  a new `reason` is permanent under ADR-0060 and buys a distinction no client can act on. **The
  cursor is also deliberately not signed**, and that half is a *decision* rather than an
  omission: the argument is beside `encodeCursor` and recorded in ADR-0064, and the short of it
  is that a forged cursor names a position inside a list the caller's credential already opens
  whole, while a signature would be kobai's first secret. Do not add one without reopening
  ADR-0064 — and note that changing what a cursor carries is a wire-format break after the
  first publish (ADR-0061).
- **The default and the ceiling are promised** (`DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT` in
  `db/page.ts`, 20 and 100) and each route's description says so, because changing either
  changes what an existing client receives.

`packages/core/src/http/pagination.test.ts` holds all of it, and holds it **once for every
list**: `LISTS` is a table of path and item key — checked against the routes the description
says take an `after`, so a list route added without an entry reddens the build rather than
quietly opting out of every sweep in the file — so a new list added there inherits the whole
contract rather than a copy of it — including the pass that offers **every** list's cursor to
**every** other list and expects all of them to refuse, which is what makes a duplicate name a
red build rather than two lists quietly reading each other's pages. Its last case is the one
that matters and the one nothing
else can see — a page fetched across a concurrent insert — and it was watched failing against
an offset implementation first, which is the discipline the two race tests already use.

**Two routes answer a set and do not page, and the boundary is written down** (ADR-0067).
`GET /admin/fulfilment-strategies` hands back every Strategy this deployment has wired, in one
response, with no `limit`, no `after` and no `nextCursor`; `GET /admin/deployment` is the second
and arrived on the identical argument (ADR-0080), carrying every declared Workflow's positions
in one answer. They are the only exceptions there are and
they are not a precedent to copy loosely: ADR-0064's whole argument is about **rows arriving
between one page and the next**, and this set is `Object.keys` of what `kobai.config.ts` wired —
decided at boot, unable to change while the process runs, with no `created_at` a cursor could be
built over. **The test is "can this set change under a reader", not "is it small"**:
`GET /admin/roles` pages although a deployment may have three Roles, because a Merchant can
create a fourth over HTTP while somebody is paging. **A borderline case is a list route**, since
paging something that did not need it costs a parameter nobody sends and the reverse costs a
break. Adding a **third** unpaged plural route means reopening ADR-0067, not following it — the
second was taken in ADR-0080 and argued there, which is the shape to copy if a third is ever
wanted.

**A correction is a `PATCH`, and there is one way to do that too** (ADR-0062). Every route that
corrects a record which already exists behaves identically on purpose: **an absent field means
"leave it"**; a named `metadata` is **replaced** and never merged, because a merge leaves no way
to take a key back out; and **a body naming nothing the route would change is refused at 400**
rather than answered 200 with the row unchanged, because a request that changes nothing is more
likely a mistake than an intention. That refusal does a second job wherever the schema strips a
field the route does not carry — a Merchant who sent a Price to a Variant, a `variants` to a
Product or only a `defaultCurrency` to the Store sent an empty body, so the refusal is where they
are told which route does it. A `PUT` beside them is a different judgement and needs one:
`PUT /admin/variants/{id}/inventory` stays a `PUT` because a count *is* the whole fact.

**`packages/core/src/patch.ts` is where that is implemented, once** (#185). It was written out
per module until it had accumulated across four files and drifted — its own header says how far,
and this file does not repeat the count. `changesFrom` narrows a body into the changes it asks for and
`changesNothing` is the refusal; `text` and `openData` are the two field narrowings almost every
correction wants. **A helper may answer with a refusal without costing ADR-0060's binding**,
which is the part worth understanding before adding to it: every narrowing there refuses
`invalid`, a **literal** that every module's union already carries, so the assignment into
`ProductUpdate`, `StoreUpdate`, `RoleUpdate` and the rest is what checks the two still agree and
a module that renamed its `invalid` still reddens. A field refusing something *else* —
`PATCH /admin/variants/{id}`'s `fulfilment`, with `unknown-fulfilment-strategy` — widens that
refusal through a type parameter rather than replacing it. **`updateCart` is the one deliberate
exception**, and its reason is written beside it: a Cart's `shopper` is three-valued and fills
two columns, and it is read by the same `parseCartInput` a create uses, so it asks of the keys
the body carried instead. **Rules do not go in that file** — whether a SKU is taken, whether this
Store prices in that currency — and neither do they go in `input.ts`, which holds the same kind
of narrowing and promises to hold no rule at all.

**A Store's default currency does not move** (ADR-0065). `PATCH /admin/store` accepts a
`defaultCurrency`, takes the code the Store already prices in — so a form submitting the whole
record round-trips — and refuses any other at **422 `default-currency-is-fixed`**, whether or not
a single Price has been written. **ADR-0074 narrowed the argument and did not weaken the rule**:
a Price carrying no Region and no Channel is denominated in the default, so moving the column
reinterprets exactly those amounts rather than converting them, and multi-currency arrives as
more rows (ADR-0008). **Do not add a currency-change path, and do not narrow the refusal to
"when Prices exist"** — relaxing it later is cheap, tightening it is a break (ADR-0060), and the
narrow version is a read of `core_price` followed by a write.

**A Store *enumerates* the currencies it may price in, and a Region *selects* one** (#291,
ADR-0074). The enabled set is `currencies` on the Store — read by `GET /admin/store` behind
`store:read`, written whole by `PATCH /admin/store` behind `store:write` — and `POST`/`GET`/
`PATCH`/`DELETE /admin/regions` and `/admin/channels` are the ten routes beside it, behind the
same two Permissions. Six things about that surface are decisions rather than implementation:

- **The enabled set is a field of the Store rather than a list route**, and the boundary is
  worth reading because the answer is *not* ADR-0067's: a Merchant can enable a currency over
  HTTP while somebody is reading, so a plural route over that table would have had to page like
  every other list. It is a field of one record instead, the way a Product's `collections` is —
  and it is the **whole set** on the way in, so enabling and disabling are one field and a code
  left out is a currency taken away. `EnabledCurrency` is an object at **both** ends for
  `MediaAttachment`'s reason: a per-currency setting arrives beside `code` and is additive,
  where a list of strings could only grow by changing the type of every element.
- **Two refusals guard that set, and they are two facts.** **422
  `default-currency-must-be-enabled`** where the set leaves out the code every unconstrained
  Price is denominated in — ADR-0065's refusal reached from the other end — and **422
  `currency-in-use`** where it takes away one a Region selects, naming the Regions, which is
  ADR-0059 at a third table: the repair is to move or delete them and send it again.
- **A Region selects a currency the Store has enabled, at the create and at the correction
  alike** — **422 `currency-not-enabled`** otherwise, on `unknown-fulfilment-strategy`'s
  distinction. It is deliberately **not** `unsupported-currency`, the word a *Price* naming
  a currency the Store has not enabled is refused with: the two repairs were opposite when
  `unsupported-currency` meant *send the Store's one code* and they still are now that it means
  *enable it or price in one you have* — there the subject is a Price and here it is a Region,
  and a client branching on a shared word would advise wrongly for one of them.
- **The Store carries a default Region and cannot be left without one.** `defaultRegion` is on
  both the read and the correction — **422 `region-not-found`** for one this Store has not got —
  and `DELETE /admin/regions/{id}` refuses **409 `region-in-use`** while the Store falls back to
  it, because something has to answer a storefront that names no Region. **Deleting a Channel
  refuses nothing**, and the asymmetry is the decision: an API key whose Channel has gone is
  unconstrained rather than broken, and refusing would make a Channel any key had ever named
  permanently undeletable, since revocation is a column rather than a delete.
- **Which Channel a request is in is decided by the API key** (ADR-0020). `POST /admin/api-keys`
  takes an optional `channelId` — **422 `channel-not-found`** through `MintApiKeyRefusal`, which
  is its own family and neither the store gate's `ApiKeyRefusal` nor `ApiKeyNotFound` — and a key
  minted without one is unconstrained, which is every key that exists today. It is decided at
  minting and never afterwards, so a storefront cannot claim to be in a Channel it was not issued
  a credential for.
- **A nullable reference to a named schema is a union and never `.nullable()`.** `Store`'s
  `defaultRegion` is `z.union([Region, z.null()])`, because `.nullable()` at a reference site is
  applied to the **registered component**: written that way, `Region` is published as
  `object | null` and `GET /admin/regions` promises a page whose items may each be `null` —
  a thing no handler produces and, under ADR-0060, a `null` a client may expect for ever.
  `Price.region`, `Price.channel` and `ResolvedPrice.channel` are three more of them (#292).
  **The rule is enforced rather than remembered** (#309) —
  `openapi.test.ts` sweeps every registered component of the generated description and fails
  naming any that admits `null`. It asks the *description* rather than `contract.ts`, so it
  catches a component published nullable by any route at all and needs no list of components to
  keep. **`Store.defaultRegion` is where the argument is written out**, and every other site in
  `contract.ts` points at it rather than restating it. That sweep was written because four sites
  had already broken the rule and nothing
  noticed: `Inventory` (`Variant.inventory`), `CartShopper` (`CartSummary.shopper` and
  `OrderSummary.shopper`) and `Payment` (`OrderSummary.payment`) were each published as
  `object | null`. Each was *accidentally* honest — every reference to them was a genuinely
  nullable one — which is exactly why it survived: the day one of them is put in a list, as
  `Region` was, the description promises a page whose items may each be `null`.

**A Price is constrained by a Region and a Channel, and resolution is best match** (#292,
ADR-0008, ADR-0074). `regionId` and `channelId` are optional on
`POST /admin/variants/{id}/prices`, `null` on the `Price` a read answers with means **applies to
all**, and `GET /store/variants/{id}/price?region=` is where the two are spent. Six things about
that surface are decisions rather than implementation:

- **The rule is two rules in an order, and the order is the decision.** A Price not denominated
  in the Region's currency does not apply *at all* — kobai converts nothing, ever — and only
  then does best match run: both constraints, then the Region, then the Channel, then the
  unconstrained fallback, with ties inside a tier broken by an ordering ending in `id` (#132).
  So a Region selecting MYR against a Variant priced only in the Store's default answers
  `price-not-set`, and **best match can never beat the currency rule**. Both live in
  `select-price`, which is a Project's to replace; `load-prices` still hands over every
  candidate, unfiltered, or the rule would be in the query where a replacement cannot reach it.
- **`?region=` is optional and its absence is the Store's default Region**, which is what keeps
  this additive under ADR-0060: a storefront written before the parameter existed sends nothing
  and is answered exactly as it was, because the Region seeded at boot selects the currency
  every existing Price is denominated in. A Region this Store has not got is **400 `invalid`**
  rather than the default — `?collection=`'s judgement one parameter along — so a storefront
  interpolating the wrong variable finds out (story 15). `pricing/market.ts` is the one place
  both price routes resolve it, so they cannot disagree about what naming nothing means.
- **The Channel comes from the API key and there is no `?channel=`** (ADR-0020).
  `AuthenticatedApiKey` carries the Channel its key was minted into, so a storefront threads
  nothing and cannot claim to be in one it was not issued a credential for. `GET
  /admin/variants/{id}/price` therefore prices against **no** Channel and always will: it is
  opened by a session, and a parameter there would let a Merchant preview a request no
  storefront could make.
- **`?region=` is a query parameter that is not a filter, and `filtering.test.ts` names it.**
  That sweep reads every non-paging query parameter as a filter of a list; this one decides
  *what the answer is* about a single record. The enumeration there is deliberate rather than a
  rule, so the next non-filter parameter has to be argued in the same place.
- **`ResolvedPrice` carries the market back out**, which is both a courtesy and the half of
  #292's break to Extension Point 2 that a compiler can see — ADR-0058's register says why, and
  the short of it is that growing a Step's *input* alone breaks nobody.
- **Deleting a Region or a Channel takes the Prices constrained to it**, which is the one place
  `core_price` departs from ADR-0059's refuse-rather-than-cascade. The test ADR-0059 applies is
  whether the repair is a control the Merchant has, and #292 answered it with *nothing lists
  Prices by Region*. **`GET /admin/prices?region=` lists them since #310 and the cascade is kept
  on a restated argument**: the repair a refusal could demand is that same deletion one row at a
  time, since no route deletes Prices in bulk, and what the list changed is that the cost is
  read before the act rather than named by a refusal after it. The column's own comment in
  `db/schema.ts` carries it, ADR-0059 carries the re-examination, and both say why `set null` is
  still the worse third answer.

**Every Price a Store holds is a list of its own, narrowed by the two things one may be
constrained to** (#310). `GET /admin/prices` pages `core_price` newest first behind
**`catalog:read`**, each row naming the Variant it prices, and `?region=` and `?channel=` narrow
it. Four things about it are decisions rather than implementation:

- **A filter narrows to the Prices that *name* a Region, never to the ones that would apply
  there.** The second question is `resolve-price`'s — the currency rule, then best match — and it
  lives in a Workflow a Project may have replaced (ADR-0017), so answering it in a `where` clause
  would put a second implementation of pricing where no replacement can reach it, which is the
  argument that already keeps `load-prices` unfiltered. **A Price constrained to nothing applies
  everywhere and is answered by the unfiltered list**, rather than by every value of the
  parameter; the sentence a client reads is on the parameter's own description.
- **There is no `?variant=`, and its absence is the decision.** A Variant's Prices are on the
  Product read already, in full — a filter here would be a second way to ask a settled question,
  and one that could disagree. The rule is `#253`'s about a route that takes a combination:
  do not answer one question twice.
- **`ListedPrice` is declared apart from `Price`**, on #207's line, and what it adds is
  `VariantIdentity`. That pair is the point rather than a courtesy: `DELETE
  /admin/variants/{id}/prices/{priceId}` needs both identifiers, so every row of this list is a
  Price a Merchant can act on — which is what let ADR-0059's cascade be re-argued rather than
  merely restated.
- **The two filters take an identifier and are judged in the handler**, exactly as `?collection=`
  is: `unusableRegion` and `unusableChannel` are asked **before** the page is read and answer the
  same `invalid` at 400, because whether a Region exists is a fact about the Store and no schema
  can hold it. A `regionId` on a *body* is still 422 `region-not-found` — the two are the line
  this surface already draws between a parameter it cannot use and a body naming a record the
  Store has not got.

**A Cart is denominated, and it switches Region in place** (#293, ADR-0074's amendment). A Cart
carries `currency` and a `region`, both on the wire; `regionId` is on `POST /store/carts` and on
`PATCH /store/carts/{id}`; and `place-order` prices in the Cart's Region through the Channel its
key was minted into. Six things about it are decisions rather than implementation:

- **The currency is stamped when the Region is set and never read through it.** That is
  ADR-0074's duplication and it survived the amendment: a Merchant may move a Region onto another
  currency, and a Cart that read its currency through one would be repriced mid-checkout. The
  Region says *where* and `core_cart.currency` says *what in*, and `pricing/market.ts`'s
  `marketOfCart` is the one place the two are put back together — the Region's `id` and `name`,
  the **Cart's** currency.
- **Switching keeps the Cart**, its identifier and every Line Item, which is affordable only
  because a Cart's lines hold no price snapshot (ADR-0009). It is a field on the correction that
  already exists rather than a route: a Cart is one record and this changes two of its columns.
- **Two facts refuse it and they are two words.** A live Reservation is **409
  `cart-is-denominated`**, read through `liveHoldOfCart` — the same expression claim-or-adopt
  decides by, so *is this Cart holding stock* has one answer; a Payment is the **409
  `cart-placed`** the route already answers, because Core writes `core_payment` in the
  transaction that writes the Order. **Do not add a third word for the Payment**: it would be two
  spellings of one fact. The hold guard takes `lockCartHold` — `holdReservations`' **own**
  advisory key — before it reads, because the condition is about *other rows* and the Cart row
  this transaction is holding says nothing about `core_reservation`. That is ADR-0018's other
  answer and `the-last-administrator`'s rule about two guards needing one key.
- **A switch that leaves a line unpriceable is refused naming those lines**, at **422
  `variant-not-priced-in-region`** — beside `variant-not-priced`, which is what an *add* meets,
  because the repairs differ. It is asked of the deployment's own `resolve-price`, threaded into
  `cart/write.ts` as a `priceable` callback rather than imported, for the reason every Workflow on
  this surface is handed in: a Project that replaced `select-price` would otherwise be refused a
  market it prices perfectly well.
- **A `regionId` naming no Region is 422 `region-not-found`, not 400 `invalid`.** That is the line
  this surface already draws between a *query parameter* it cannot use (`?region=`, `?collection=`
  — 400) and a *body* naming a record the Store has not got (`collections` — 422, the record's own
  word). One fact gets one word whichever end asks it (ADR-0060).
- **The Channel reaches the checkout path off the key** (ADR-0020). `PlaceOrderRequest` and
  `LoadedCart` carry it, `POST /store/carts/{id}/reservations` threads it although it prices
  nothing — one reading of a Cart, one shape — and there is no `channelId` on any body. That is
  #292's second half: until this, `place-order` read the Store's default Region and passed
  `channel: null`, so a Store with a constrained Price quoted one number and charged another.

**A Cart carries an Address and an Order snapshots one, and Core checks its shape and nothing
else** (#319, ADR-0072, ADR-0009). `address` is on `POST /store/carts` and on
`PATCH /store/carts/{id}`, three-valued exactly as `shopper` is — absent leaves it, `null` takes
it off, an object replaces the whole of it — and `Cart.address` and `Order.address` are the two
shapes that come back. It sits behind the Cart's own identifier and no credential of a Shopper's
(ADR-0020), and there is **no new Permission**: a Merchant reads it through the Order, which
`order:read` already covers. Six things about it are decisions rather than implementation:

- **Structural, and the whole of what "structural" means here is four fields.** A two-letter
  country code, at least one line, an optional postal code, and an optional `regionId`. There is
  no `city`, no `state`, no recipient and no telephone number, because named parts would be kobai
  asserting that every country's addresses decompose the same way — which is exactly the claim
  ADR-0072 says no library settles. **A country's own format rules are refused by nothing**, and
  `cart/an-address-on-a-cart.test.ts` places an Order for an address no postal authority would
  accept, so that is a promise rather than an omission.
- **The country is a *code* and that is a shape rather than a rule.** `char_length = 2`, on
  `core_store_currency`'s bargain: what makes a code a real country is not a fact a table can
  hold, and the length is. It is the one field Core's own arithmetic will read — shipping and tax
  both key off it — so free text would have been an address kobai could model nothing from.
- **Nothing makes an Address mandatory.** A Cart with none reads, quotes and places. Whether
  *shipping* requires one is a decision about shipping and belongs to the ticket that builds it.
- **One Address per Cart, replaced in place, and `null` deletes the row.** Nothing lists, reads
  or deletes an Address on its own, so a create-per-correction would accumulate rows no route can
  reach. `address.regionId` naming no Region is **422 `region-not-found`** — the word the admin
  surface already answers, because one fact gets one word whichever end asks it (ADR-0060) — and
  no new refusal family was added anywhere.
- **The Order's copy is a table of copies, and `core_order_address` carries no `address_id` at
  all.** Not nullable, not `set null`: absent. An Order that pointed at the Cart's Address would
  be rewritten by a Shopper correcting their details and emptied by one clearing the Address off
  the Cart, which is ADR-0009's Line Item argument one noun along. The one reference on that row
  is `region_id`, which is navigation in the shape `core_order_line_item.variant_id` already
  has — `set null`, with a snapshotted `region_name` beside it as what a person reads.
- **Deleting the Region an Address names is `set null`, and it is a third answer rather than
  either of the two already on this schema.** `core_cart.region_id` is `set null` and
  `core_price.region_id` cascades; ADR-0059 is where the argument for the Address lives, under the
  heading naming it, and the short of it is that a refusal would name rows only a Shopper can
  repair and a cascade would throw away a destination that is still exactly where the parcel goes.
  **`foreignKeysTargeting` is asked of `core_address`** in that test file — one key, the Cart's —
  so the day it becomes a scoping key the build goes red rather than the retrofit going unnoticed,
  and `region.test.ts`'s own sweep now names the two new keys onto `core_region`.

**A Role is a row a Merchant can make, and one Permission administers every change to one**
(ADR-0066, ADR-0076). `POST`/`GET`/`PATCH`/`DELETE /admin/roles` and `GET /admin/merchants` are
#173's six, and `PATCH /admin/merchants/{id}` is #202's seventh.
The three **writes** sit behind **`merchant:write`** and there is deliberately no `role:write`
beside it: a Merchant who may add a colleague may add one against `owner`, so that Permission is
already the power to administer access entire, and a second word would name a boundary that does
not exist. The three **reads** — `GET /admin/roles`, `GET /admin/roles/{id}` and
`GET /admin/merchants` — sit behind
**`merchant:read`**, because that argument reaches the writes and stops there. Seeing the roster
escalates to nothing, and gating it on the write meant granting the power to change who has
access in order to let somebody see it; `merchant:` would also have been the only family here
with a write and no read. Four things about that surface are decisions and not implementation:

- **A read is `merchant:read` and a write is `merchant:write`, and neither moves.** Which gate a
  route sits behind is promised surface (ADR-0060), so a route added here takes the one its verb
  says — a new write, `DELETE /admin/merchants/{id}` included, needs no Permission of its own.
  `PATCH /admin/merchants/{id}` is the one that has since been added, and it took `merchant:write`
  on exactly that argument (ADR-0076).
- **A Permission Core has never heard of is stored, not refused.** `permissions` is an array of
  non-empty strings and nothing checks *which* strings — a shape, not a vocabulary. `Session`'s
  own description already promises this ("a deployment may hold a permission this build of Core
  has never heard of"), and closing the set would foreclose a Plugin-supplied Permission before
  anybody has designed one. **Do not validate against `PERMISSIONS`**; the Admin's picker is
  where a typo is caught, as an affordance (ADR-0063).
- **The last Merchant able to administer Merchants cannot be stripped, and cannot be moved off
  the power either.** `PATCH /admin/roles/{id}` and `PATCH /admin/merchants/{id}` both refuse at
  **422 `last-administrator`** — one word for one fact, reached by two acts — because the first
  Merchant is seeded only while there is none (ADR-0041) and the way back would be raw SQL.
  **The guard is a `pg_advisory_xact_lock` taken before the read, not a conditional update** —
  the condition is about *other* rows, which a subquery does not lock, so ADR-0018's
  one-statement answer does not reach it and two requests each removing a different last
  administrator would both commit. It lives in `packages/core/src/auth/administrators.ts`
  because **both routes must take the same key**: two correct guards on two keys serialise
  nothing against each other, which is a lockout reached by two changes that each refused to
  cause it alone. `packages/core/src/auth/the-last-administrator.test.ts` is the concurrent
  test, it dispatches at both routes, and each case has been watched failing — the second
  against a build with a second key.
- **A Role Merchants hold is refused rather than cascaded or reassigned** — **422 `role-in-use`**,
  ADR-0059's shape reached through `core_merchant.role_id`'s `on delete restrict`. The delete is
  one statement and the violation is *read* (`violatesForeignKey`), not asked for first: a
  `select` then a `delete` lets a concurrent `POST /admin/merchants` slip a holder in between.
  **Its remedy is `PATCH /admin/merchants/{id}` and it had none until #202** — the refusal
  pointed at the Merchants holding the Role and nothing could move any of them off it, so
  ADR-0059's "the repair is one a Merchant can carry out themselves" was not true on this table.
  A refusal whose advice names no reachable control is the finding to raise, not to word around.

**A route needing a Permission Core does not define yet brings one with it**, which is one edit
and one migration. The new string goes **last** in `PERMISSIONS` (`auth/permissions.ts`), because
`ALL_PERMISSIONS` is that literal's declaration order and `auth.test.ts` holds the seeded `owner`
Role equal to it; then a `--custom` migration appends it to `owner`, the way `0029` and `0030`
do. Skip the migration and every deployment that upgrades gets a route nobody can call. **The
read/write split is the house rule** — `store:read` is not `store:write`, as `catalog:`,
`api-key:` and `merchant:` already are — because which gate a route sits behind is promised as
well (ADR-0060), so gating a write behind a read permission is a break to undo rather than a
decision to take, and gating a read behind a write is granting the power to change a thing in
order to let somebody see it. `order:read` stands alone only because an Order is immutable
(ADR-0009), so there is no write for a Permission to gate.

**A declared refusal must have the gate that makes it.** Five of the statuses a route
declares are not the handler's to answer — they are made above it, by middleware: `503` by the
migration gate, `401` by the session gate at `/admin` and by the API-key gate at `/store`,
`403` by `requirePermission`, and `403` again by `requireSecretApiKey` on the `/store` routes
that take money (ADR-0055). **The two `403`s are two entries in `GATE_REFUSALS`, deliberately**
— one is a Merchant's Role being too narrow and the other is a browser's key on a route it may
not open, so sharing an entry would let a route declare one and be gated by the other.
Nothing the compiler does can see any of them, so each gate is built
through `gateAnswering` (`packages/core/src/http/gate-refusals.ts`), which marks it with the
refusal it makes, and `openapi.test.ts` reads the marks back off **Hono's own route table** —
the thing dispatch reads — and holds every operation to declaring exactly the refusals its
chain can answer. Both directions fail: a declared `403` with no `requirePermission` promises
a check that does not exist, and a gate whose route declared no `403` hides a refusal a
generated client cannot narrow on. Gating a route stays `middleware:
[requirePermission(…)] as const` on the declaration and nothing else — **nothing is registered
twice**, and a new gate needs one entry in `GATE_REFUSALS`.

The check deliberately covers **all of them**, not just the `403` #56 asked for: the session and
API-key gates are mounted per surface with `use("*")`, so the mistake they catch is a route
registered on the wrong half of `admin.ts` — anonymous access to the admin surface, which
nothing else here would notice. It stops at the status: the *reasons* inside a refusal are
pinned one level down, in `contract.ts`, and **a reason a module refuses with is bound to that
module's own union by a mapped `satisfies`** — so the declared set is exactly the refusals that
module can make, a new one has no key and does not compile, and a rename turns `contract.ts` red
naming the word. `SESSION_REASONS` and `API_KEY_REASONS` are the two gates'; #149 built the rest
of Core's the same way (ADR-0060). **Read the file rather than counting them here**, because the
construction is not uniform and each departure has a reason. A reason written *above* every
handler has no module to map over: `REQUEST_REASONS` is `invalidRequestHook`'s and
`app.onError`'s two, spread into every family a body can reach. A reason a **handler** writes by
hand is bound instead by the schema it is typechecked against — `ApiKeyNotFound`'s `z.literal`
answering the handler's own `reason: "…" as const`, `OrderRefusal`'s one-member enum,
`PlaceOrderRequestRefusal`'s `metadata-in-both` — where a rename on either side still fails the
build, which was checked rather than assumed. And the two families a **Step** refuses through —
`PriceRefusal` and `PlaceOrderRefusal` — keep `reason` an **open string**, because closing them
would close Extension Point 2; Core's own words are listed in each schema's `description`, built
from the constant rather than retyped, and that constant *is* held to the modules' unions by the
same mapped `satisfies`. **No route is excused.** `POST /admin/merchants` was the
one that had to be, because the first Merchant had to be creatable with no session at all, so
it asked the same question inside its handler; #25 moved the first Merchant to a boot-time
seed and the route took the ordinary middleware, so every refusal every operation declares is
now made by a gate this check can see.

**The description is not served *anonymously*** (ADR-0080). `/store` refuses an
unauthenticated request *before* saying whether a path exists, and an endpoint handing out the
whole surface to anyone who asks would undo that — so the objection was always to the
anonymity, and it still stands. **`GET /admin/openapi.json` serves it behind a Merchant session
and `deployment:read`**, which is a caller who has already presented a credential `/store`
never accepts. Three things about that route are decisions rather than implementation:

- **It is served rather than bundled, and that is the narrow argument.** `@kobai/client`'s
  `schema.ts` is types, erased at build, so a browser client holds no description at runtime at
  all; and importing `@kobai/core/openapi.json` would ship a *package's* build artifact as
  though it were a server's answer, in a Project where `@kobai/core` and `@kobai/client` are
  two independently pinned dependencies in a lockfile the Developer owns.
- **The body is an open object**, described in prose in `contract.ts` the way `OpenMetadata` is.
  An OpenAPI document is a recursive schema kobai does not own, and modelling it in zod would
  be a second and worse copy of a specification for a value every consumer feeds to a tool that
  already knows the shape.
- **It describes itself** — its own path is in the document it returns, which follows from the
  description being produced from the route table the declaration is registered in.

A Developer may still read it from the package (`@kobai/core/openapi.json`); a TypeScript one
installs `@kobai/client`.

**`GET /admin/deployment` is the route beside it, and the one that answers what nothing else
does** (ADR-0080): the release of Core, every declared Workflow's positions with the **origin**
of the Step in each, and whether a Payment Provider is wired. It carries neither the Fulfilment
Strategies nor the migration sets, because `GET /admin/fulfilment-strategies` and `GET /health`
already answer those and a second description of one fact is one that can disagree. **It is the
second route on the far side of ADR-0067's boundary** and does not page. Two things to carry:

- **A Step's origin is recorded where the rewiring happens and never inferred.** `slot` and
  `step` agree for a Core default — and for an **inserted** Step, which occupies a position
  under its own name, and for a **replacement** that answers to the slot's name — so
  `slot === step.name` reads two customised deployments as stock, confidently and silently.
  `rewireWorkflow` holds both the stock declaration and the result, so `WorkflowStep.origin` is
  written there.
- **The version is `coreVersion()`**, the same function that fills the description's
  `info.version`. The surface's version *is* the package's (ADR-0060), so the route is a second
  reader of that fact and not a second copy of it.

**A path no route serves is a refusal too, and it is not in the description.** One
`app.notFound` in `app.ts` answers every unrouted path — on both surfaces and at the root —
with the same `{ error, reason: "not-found" }` at 404, because a client that got JSON for
every failure it could anticipate and plain text for the one it could not would find out at
runtime (#33). It is a handler rather than a route, so it is deliberately absent from the
description: a description enumerates the paths that exist. It also runs *after* both
credential gates, which are mounted `use("*")` and therefore answer before routing — so an
anonymous caller gets 401 for a nonexistent admin path, not 404, and cannot map either
surface. That ordering is a decision, not an accident; ADR-0040 says where the line is.

`openapi-typescript` is pinned to **6.7.6, exactly**, and `.github/dependabot.yml` holds the
major back. Version 7 builds its output with the TypeScript compiler API and TypeScript 7
ships none — see below.

