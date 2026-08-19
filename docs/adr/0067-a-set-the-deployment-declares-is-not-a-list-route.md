# A set the deployment declares is not a list route

`GET /admin/fulfilment-strategies` answers **every** Fulfilment Strategy this deployment has
wired, in one response. It takes no `limit`, takes no `after`, and carries no `nextCursor`.

[ADR-0064](./0064-list-pagination-is-a-cursor-and-the-page-number-is-given-up.md) says "**every
list route**, uniformly … a surface where some lists page and others do not is one a client has
to learn twice", and this is the first route on kobai's surface that does not. So the boundary
is drawn here rather than left as an exception somebody has to notice: **a list over a table
pages, and a set the deployment declares does not.**

## Why the route exists at all

Two routes refuse `unknown-fulfilment-strategy` — `POST /admin/products` and
`PATCH /admin/variants/{id}` — and until now nothing could ask what the *known* ones are. A
Merchant naming a Strategy had to guess and be refused; a client offering a choice had to
hard-code `physical` and `digital`, which is exactly the closed set
[ADR-0014](./0014-fulfilment-strategy-replaces-requires-shipping-and-tracks-inventory.md) exists
to rule out, written into every client instead of into the schema — and it would be *wrong* on
any deployment that wired a Plugin's Strategy, which is the case ADR-0014 was written for.

[ADR-0010](./0010-the-admin-ships-in-one-container-and-gets-no-private-api.md) says the Admin
gets no private API precisely so that a gap like this surfaces as a finding about the API. #179
is where it surfaced, building the screen that swaps a Variant's Strategy.

**It answers a name and nothing else.** A Strategy has no `name` of its own — it is named by
the key `kobai.config.ts` wired it under — and its three answers are asked *of a Variant*,
because a Strategy may read that Variant's `metadata` to answer them (ADR-0013, ADR-0014).
There is no Variant here, so there is no honest answer to carry, and a Strategy that answers
differently per Variant would be misreported by whichever one was picked to ask about.

## Why it does not page

**ADR-0064's argument is about rows, and there are none.**

Read that record's own reasoning: `limit`/`offset` is evaluated against the table as it is at
the moment each page is fetched, so a row inserted between page 1 and page 2 is shown twice or
never shown at all. The answer is a keyset cursor — `where (created_at, id) < (:after)` —
evaluated against the row rather than the position, over an ordering that cannot tie.

Every premise of that fails here:

- **There is no table.** The set is `Object.keys` of what `resolveFulfilmentStrategies` built at
  boot: Core's two, with whatever `kobai.config.ts` wired over them.
- **Nothing can be inserted between one request and the next.** It is decided before the server
  listens and cannot change while the process runs. Wiring a Strategy is editing a file and
  restarting, which is not a concurrent insert; it is a different deployment.
- **There is no cursor to build.** No `created_at`, no `id`, nothing `packages/core/src/db/page.ts`
  operates on. A cursor over an array index is the *position* pagination ADR-0064 rejects, with
  a base64 wrapper on it.
- **It is bounded by a file a human wrote.** A deployment with enough Strategies to need a
  second page has a configuration problem no API can page around.

**Paging it anyway was considered, and the cost is not the machinery.** Synthesising cursors
over the sorted names is a few lines. What it buys is uniformity, and what it costs is that the
opaque cursor stops being opaque-over-something and becomes opaque-over-nothing: kobai would
promise, under [ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md),
a paging protocol for a set that cannot be paged, and every client would write the loop for it
forever. Uniformity is worth having where clients differ; it is not worth a contract that
describes a hazard the route does not have.

## The boundary, so the next route knows which side it is on

**Pages** — a list whose contents are rows the deployment accumulates: Products, Orders, API
keys, Merchants, Roles. Anything a request can add one to. All of ADR-0064, unchanged.

**Does not page** — a set fixed by the deployment's own configuration, readable in full,
unable to change without a restart. Today that is exactly this route.

The test is not "is it small". `GET /admin/roles` pages and a deployment may have three Roles,
because a Merchant can create a fourth over HTTP while somebody is paging. The test is **can
this set change under a reader**, which is the failure ADR-0064 is about. If it can, it pages.

**A borderline case is a list route.** The cost of paging something that did not need it is a
parameter nobody sends; the cost of not paging something that did is a break at the first
publish ([ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md),
[ADR-0061](./0061-what-the-first-publish-owes.md)) or a lying list after it. Those are not
symmetrical, so the doubt resolves toward ADR-0064.

## Considered and rejected

**Fold it into `GET /admin/store`**, as a `fulfilmentStrategies` field. Additive, and no new
path or list question at all. Rejected because it puts deployment wiring inside a *record* — a
Store is a row with a name, a currency and metadata, and the Strategies are none of those — and
because it would gate the answer on `store:read`, so a Merchant who may fill in a Variant's
Strategy would need a Permission about the Store to find out what to type.

**Leave it out and let the refusal teach.** `unknown-fulfilment-strategy` already names the
wired Strategies in its prose, so a Merchant does learn the set — after being refused, one
attempt at a time, from a string meant for a person rather than a program. That is the state
#179 found and the reason this route was asked for.

**A Permission of its own.** The one thing this is for is filling in a Variant's Strategy, and
a Merchant without `catalog:read` has no Variant to fill in. A `fulfilment:read` beside it would
name a boundary that does not exist, and which gate a route sits behind is promised under
ADR-0060.

## Consequences

- **`packages/core/openapi.json` now describes one list route with no page parameters.**
  `tests/…` reads the surface for the paging contract through `LISTS` in
  `packages/core/src/http/pagination.test.ts`, which is a table of the routes that page; this
  route is deliberately not in it, and its own test asserts it takes no page query.
- **The Admin gets a picker instead of a text field.** `reference/admin/` reads this route to
  offer the Strategies a Variant may point at, which is the whole reason it was built — and it
  still predicts no refusal: naming a Strategy unwired between the read and the submit is
  attempted and refused like anything else (ADR-0063).
- **This is new promised surface** and falls under ADR-0060 from the day it ships, with
  ADR-0058's licence to change it expiring at the first publish.
- **Adding a field to `FulfilmentStrategySummary` is additive**, which is why it is an object
  rather than a bare string. If a Strategy ever gains something it can say about itself without
  being handed a Variant, it goes there.
