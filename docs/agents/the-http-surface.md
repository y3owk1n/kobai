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
  without one — and it deliberately **does not page**, which is the one departure from ADR-0064
  on the whole surface.

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
`CatalogRefusal` is nine, bound by its own mapped `satisfies`, because a storefront must not be
handed `sku-taken` as something a catalog read might answer.

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
this is not the shape the paragraph above rules out. Everything else on the surface stays a
module-level constant.

**Drift fails the build, in two places.** `packages/core/openapi.json` and
`packages/client/src/schema.ts` are both generated and both checked in.
`packages/core/src/http/openapi.test.ts` regenerates the description and compares;
`packages/client/src/schema.test.ts` regenerates the client and compares. Both run under
`devbox run ci`. Regenerate with `devbox run openapi:generate` — Core first, then the client,
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
without running `devbox run openapi:generate` fails `openapi.test.ts` twice**: once as a byte
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
`packages/core/src/db/page.ts`. Six things about it are decisions rather than implementation:

- **`nextCursor` is absent on the last page and that is the only end-of-list signal.** A short
  page is not one — a filtered page can be short and not last — so a reader fetches `limit + 1`
  rows through `pageSize`/`takePage` and reports a cursor exactly when the extra row exists. A
  count would be a second query over the whole table to answer a question with two answers.
- **The ordering ends in `id`, and the cursor is the same pair.** #132 already paid for a tie
  once, where it made the upgrade gate red *sometimes*; at a page boundary a tie skips or
  repeats a row instead of merely reordering it. `0028` indexes `(created_at, id)` on the three
  tables — ascending though every reader wants descending, because one ordering reversed whole
  is a backwards scan of the same index.
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

**One route answers a list and does not page, and the boundary is written down** (ADR-0067).
`GET /admin/fulfilment-strategies` hands back every Strategy this deployment has wired, in one
response, with no `limit`, no `after` and no `nextCursor`. It is the only exception there is and
it is not a precedent to copy loosely: ADR-0064's whole argument is about **rows arriving
between one page and the next**, and this set is `Object.keys` of what `kobai.config.ts` wired —
decided at boot, unable to change while the process runs, with no `created_at` a cursor could be
built over. **The test is "can this set change under a reader", not "is it small"**:
`GET /admin/roles` pages although a deployment may have three Roles, because a Merchant can
create a fourth over HTTP while somebody is paging. **A borderline case is a list route**, since
paging something that did not need it costs a parameter nobody sends and the reverse costs a
break. Adding a second unpaged plural route means reopening ADR-0067, not following it.

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
a single Price has been written. Every Price carries the Store's default and no other (#5), so
moving the column reinterprets each of those amounts rather than converting them, and ADR-0008
already says where multi-currency arrives: as more rows. **Do not add a currency-change path,
and do not narrow the refusal to "when Prices exist"** — relaxing it later is cheap, tightening
it is a break (ADR-0060), and the narrow version is a read of `core_price` followed by a write.

**A Role is a row a Merchant can make, and one Permission administers every change to one**
(ADR-0066). `POST`/`GET`/`PATCH`/`DELETE /admin/roles` and `GET /admin/merchants` are #173's six.
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
- **A Permission Core has never heard of is stored, not refused.** `permissions` is an array of
  non-empty strings and nothing checks *which* strings — a shape, not a vocabulary. `Session`'s
  own description already promises this ("a deployment may hold a permission this build of Core
  has never heard of"), and closing the set would foreclose a Plugin-supplied Permission before
  anybody has designed one. **Do not validate against `PERMISSIONS`**; the Admin's picker is
  where a typo is caught, as an affordance (ADR-0063).
- **The last Merchant able to administer Merchants cannot be stripped.**
  `PATCH /admin/roles/{id}` refuses at **422 `last-administrator`** when the change would leave
  no Merchant holding `merchant:write`, because the first Merchant is seeded only while there is
  none (ADR-0041) and the way back would be raw SQL. **The guard is a `pg_advisory_xact_lock`
  taken before the read, not a conditional update** — the condition is about *other* rows, which
  a subquery does not lock, so ADR-0018's one-statement answer does not reach it and two requests
  each stripping a different last administrator would both commit.
  `packages/core/src/auth/the-last-administrator.test.ts` is the concurrent test, and it has been
  watched failing with that line removed.
- **A Role Merchants hold is refused rather than cascaded or reassigned** — **422 `role-in-use`**,
  ADR-0059's shape reached through `core_merchant.role_id`'s `on delete restrict`. The delete is
  one statement and the violation is *read* (`violatesForeignKey`), not asked for first: a
  `select` then a `delete` lets a concurrent `POST /admin/merchants` slip a holder in between.

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

**The description is not served.** `/store` refuses an unauthenticated request *before*
saying whether a path exists, and an endpoint handing out the whole surface anonymously would
undo that. A Developer reads it from the package (`@kobai/core/openapi.json`); a TypeScript
one installs `@kobai/client`.

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

