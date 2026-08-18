# The HTTP surface is promised, and a refusal's `reason` is part of it

kobai's HTTP surface is covered by Core's semver promise. **What a caller sends and what
kobai answers with** — the paths and methods that exist, the fields a request accepts, the
fields a response carries, the status each outcome is answered at, and the `reason` string
inside a refusal — is something a storefront, an Admin or any other client may depend on, and
a minor release may not break it. `@kobai/client` is promised as a faithful projection of it.

**The five Extension Points of [ADR-0003](./0003-the-extension-surface-and-what-we-promise.md)
stay five, and stay closed.** This is not a sixth, for the reason the third section gives:
they are places Core is *extended*, and this is the place Core is *consumed*. It is the
second exception to
[ADR-0019](./0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md)'s
"and nothing else", after
[ADR-0047](./0047-the-test-harness-is-promised-surface.md)'s, and it is recorded the same way.

## Why it needed saying at all

ADR-0019 says semver covers ADR-0003's five "and nothing else", and ADR-0003's own list of
what is unpromised ends with **"anything not reachable through the five surfaces above"**.
Read strictly — and it means to be read strictly — that puts a storefront's `POST
/store/orders` in the same bucket as a Core internal: reachable, unpromised, changeable
without notice.

Nothing else in the record agrees with that reading, and three decisions actively contradict
it:

- **[ADR-0002](./0002-headless-the-storefront-is-out-of-scope.md)** — "the API is a product
  surface in its own right, not an implementation detail, because for a Developer building a
  storefront it *is* the product." kobai ships no storefront, so there is nothing else for
  that Developer to hold.
- **[ADR-0010](./0010-the-admin-ships-in-one-container-and-gets-no-private-api.md)** — the
  Admin may use only the public API, enforced by
  `tests/admin-uses-only-the-public-api.test.ts`. kobai's own first client is *forbidden* any
  other surface, and it branches on `reason` today: `app.tsx` watches for `session-expired`
  and `storefront-price.tsx` for the `api-key-` prefix.
- **[ADR-0040](./0040-an-unrouted-path-is-a-refusal-and-the-gate-answers-before-it.md)** —
  "changing the shape or the `reason` later is a **breaking change to the contract**, the same
  as changing a declared response." That sentence already decides this ADR's question for one
  body. It was written as if the rule it appeals to existed. It did not.

**And the absence has already produced two wrong answers in one week.**
[ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md), recording
#117's break, needed to say whether the HTTP contract was covered, found no rule, and settled
the instance by arguing the change was additive — true, and not a rule. #146 asserted the
opposite, that ADR-0019 already put the surface under semver once released, and its
implementer checked and found it false. Two people reading the same record reached two
answers, which is the evidence that the silence was a trap rather than a decision.

So this record is not inventing a policy. It is writing down the one every other decision has
been assuming, and the direction is not a close call: a headless engine whose wire format may
move in a minor is not headless, it is unusable.

## Why this is not a sixth Extension Point

ADR-0047 had to answer the same question about the test harness and answered it by kind
rather than by importance. The same answer works here and is worth stating plainly, because a
reader arriving at ADR-0003 and finding six things where the header insists there are five
would conclude the record contradicts itself.

**An Extension Point is where a Project or a Plugin supplies code that Core calls.** A
Workflow Step, a substituted interface, a configuration key, an event handler, an Admin slot
— each one is an *attachment*: it runs in Core's process, it is resolved by name at boot, and
it is a permanent constraint on Core's own architecture. That is why ADR-0003 calls the list a
one-way door and why growing it is expensive.

**The HTTP surface is where anybody consumes kobai.** Nothing attaches to it. No deployment
loads a line of a caller's code through it. It constrains what kobai *answers*, not what kobai
is built out of, and Core may rewrite every module behind a route without touching it.

[ADR-0006](./0006-typescript-on-node-with-a-rest-openapi-contract.md) is what makes that
distinction load-bearing rather than rhetorical. It rejected tRPC **outright** — "it locks
every consumer into TypeScript, which contradicts ADR-0002" — so the surface exists precisely
so a consumer need not share kobai's language, let alone its process. A thing a Ruby
storefront consumes over a socket is not a place kobai's own code is extended at, whatever
else it is.

So the list of things Core's semver covers now has three entries and one of them is still
five: **ADR-0003's five Extension Points, `@kobai/core/testing`, and the HTTP surface.**
ADR-0019's sentence has two exceptions; this is the second, and the next thing that wants to
be one still needs its own ADR.

## Where the line sits

**The promise is the wire.** The description is generated from the route objects the
application is built from, so it cannot say something the surface does not do — but it can
say *less* than the surface does, which is not a hypothetical: `malformed-body` escaped two
closed `reason` sets from the day each was written until this change (see below). So the promise attaches to what kobai actually
answers, and `packages/core/openapi.json` is evidence of it rather than the thing itself.

### Promised — a break is a major

Under [ADR-0035](./0035-upgrading-is-a-command-kobai-ships.md) a `0.x` minor counts as a
major, since `^0.1.0` means `>=0.1.0 <0.2.0`.

| What | Promised | May grow in a minor |
| --- | --- | --- |
| **Paths and methods** | An operation that exists keeps its path and its method. | A new path, or a new method on an existing path. |
| **Request shapes** | A field that is accepted stays accepted, with the same meaning. Making an optional field required, adding a required one, or narrowing the values a field takes is a break. | A new **optional** field; a widening of what an existing field accepts. |
| **Response shapes** | A field a response carries stays carried, with the same name, type and meaning. Removing one, renaming one, retyping one, or making a present field optional is a break. | A new field. [ADR-0056](./0056-a-payment-records-whether-the-money-arrived.md)'s `received` and ADR-0058's `OrderLevelAdjustment.tax` are the worked examples. |
| **Status codes** | The status a given outcome is answered at. Answering an existing outcome at a different status is a break. | A status for an outcome that could not previously occur. |
| **Refusal `reason` strings** | The spelling and the meaning of every reason Core answers with. Renaming one, removing one, or reusing one for something else is a break — including where the route's schema does not yet say so. | A reason for an outcome that could not previously occur. |
| **Which credential opens a route** | The gate a route sits behind, and the refusal that gate makes. Moving a route to the other surface, or requiring a secret key where a publishable one worked ([ADR-0055](./0055-placing-an-order-requires-a-secret-key.md)), is a break. | — |
| **The unrouted-path 404** | `{ error, reason: "not-found" }`, though no route declares it. ADR-0040 already said so and this record does not weaken it. | — |
| **Documented behaviour** | What a route says it does — "newest first", "the same key answers 200 with that Order instead of 201", "the value is in this response and in no other". Only the *wording* is free. | — |
| **Component names** | The name of a schema a route references, because that is the name `@kobai/client` gives the type. | A new component. |

**Two of those growth rules have a sharp edge, and it is the same edge.** A new status, or a
new member of a closed `reason` enum, is additive on the wire and is *not* additive for a
client that narrowed exhaustively: regenerating `@kobai/client` turns a complete `switch` into
an incomplete one. That is a compile error rather than a runtime surprise, which is the good
half of ADR-0058's second rule — but it is a compile error only a TypeScript consumer gets. So
**an addition here is owed a written note in the release, and a client is expected to treat an
unrecognised `reason` as "refused" rather than as impossible** — which is the discipline the
two deliberately open sets already demand of everybody.

### Not promised

- **Prose.** `error` is the half of a refusal written for a person, and its wording may change
  at any time; `reason` is the half written for a program. That split is already the doc
  comment on the refusal shape, and this record makes it the promise boundary. A route's
  `summary` and `description` are the same: the behaviour they document is promised, the
  sentence is not.
- **The description's serialisation.** Key order, the OpenAPI dialect emitted, the absence of
  `operationId`s, and the `info` block. The block is *unpromised*, not meaningless: when this
  was written it said `version: "0.0.0"` and named no release at all, while `app.ts`'s comment
  beside it claimed it "moved with `@kobai/core`'s" — a gap this record named and left open.
  #158 closed it, by reading the version off `@kobai/core`'s own manifest where the document is
  built. What is promised is the surface the block describes, not the block.
- **Identifier formats.** An identifier is an opaque string. That it is a UUID today is not a
  promise, and a client that parses one is depending on something it was not offered.
- **Timing, ordering not documented, performance, and anything about the database.** The
  schema is unpromised by ADR-0003 and
  [ADR-0004](./0004-plugins-own-their-tables-core-tables-are-closed.md) and reaching it
  through a route's answer does not change that.
- **The `reason` inside a refusal a Step made.** Deliberately, and the next section is why.

### `@kobai/client`: a promise, one level removed

ADR-0006 makes the generated client "a first-class deliverable, not a convenience", and this
record does not downgrade it. But the promise it carries is **the description's**, not one of
its own: `@kobai/client` is promised to be a faithful projection of `packages/core/openapi.json`
— which `packages/client/src/schema.test.ts` proves on every build by regenerating it and
comparing — and its types therefore move exactly when, and only when, the surface above moves.

What is **not** promised is the *spelling* the generator chooses. `openapi-typescript` is
pinned at 6.7.6 because version 7 needs a TypeScript compiler API that TypeScript 7 does not
ship; when that pin moves, the emitted TypeScript may change shape — a union written
differently, a component reached by another path — with no change to the wire at all. That is
a break the Project's own compiler catches and announces, which is exactly the class ADR-0058
put in the compiler's hands, and it is not a break of the promise above.

## What enforces it, and what the compiler cannot see

`packages/core/src/http/openapi.test.ts` and `packages/client/src/schema.test.ts` prove that
the description matches the routes and the client matches the description. **Neither proves a
change was allowed**, and the difference is not academic.

**Verified against `main` before writing this.** `last-variant` was renamed to
`last-variant-RENAMED` in `catalog/delete.ts`, in `admin.ts`'s `VARIANT_DELETION_STATUS` map,
and in the one test that asserts it — the whole of a consistent refactor. `devbox run
typecheck` passed. All 504 tests of `packages/core/src` passed. `devbox run
openapi:generate` rewrote `packages/core/openapi.json` and `packages/client/src/schema.ts`
**byte for byte identically**: `git status` reported no change to either. The only complaint
anywhere was Biome objecting to the line length of the edit itself. A storefront branching on
that string would have found out in production.

**The same rename now fails to compile**, in `contract.ts`, naming the reason:

```
error TS2353: Object literal may only specify known properties,
and '"last-variant"' does not exist in type '{ …; "last-variant-RENAMED": …; }'.
```

The cause is that the shared refusal schema typed `reason` as `z.string()`, so thirteen of
Core's own reasons were structurally invisible — every one it could carry. The complete list
as it stood (the twelve on `POST /store/orders` are a separate case, two paragraphs down):

| Reason | Status | Where |
| --- | --- | --- |
| `invalid` | 400 | every route with a body |
| `malformed-body` | 400 | every route with a body — see below |
| `unknown-role` | 400 | `POST /admin/merchants` |
| `email-taken` | 409 | `POST /admin/merchants` |
| `sku-taken` | 409 | `POST /admin/products` |
| `unknown-fulfilment-strategy` | 422 | `POST /admin/products` |
| `product-not-found` | 404 | `GET`/`DELETE /admin/products/{id}` |
| `variant-not-found` | 404 | `DELETE /admin/variants/{id}`, both Price routes, `PUT …/inventory` |
| `last-variant` | 409 | `DELETE /admin/variants/{id}` |
| `stock-is-reserved` | 409 | `DELETE /admin/products/{id}`, `DELETE /admin/variants/{id}`, `PUT …/inventory` |
| `price-not-found` | 404 | `DELETE /admin/variants/{id}/prices/{priceId}` |
| `unsupported-currency` | 422 | `POST /admin/variants/{id}/prices` |
| `api-key-not-found` | 404 | `DELETE /admin/api-keys/{id}` |

**So the reasons are narrowed**, in the shape `SessionRefusal` and `ApiKeyRefusal` already
use: a mapped `satisfies` over the union each module already declares, so the enum is the
*complete and exact* set rather than a remembered one. A module that grows a refusal has no
key here and does not compile; a module that renames one turns this red naming it, which is
the failure the experiment above could not produce.

One schema per family rather than one per status, following `CartRefusal`. **A per-status
schema does compile** — that was checked rather than assumed, by declaring `DELETE
/admin/variants/{id}`'s 404 as a set of one and its 409 as a set of two and finding the
handler still assignable — so this is a choice and not a constraint, and it is taken on three
grounds. `CartRefusal` is one set across six routes on the other surface, and two shapes for
one job read worse than either. Every component name is promised by this record, so twenty
names would be twenty promises doing four names' work. And the precision a per-status schema
buys is already carried by each route's own per-status `description`, which is where
`CART_REFUSALS`' three differently-worded 404s live.

**Two `reason`s stay open strings, and that is the point of them.** `PriceRefusal` and
`PlaceOrderRefusal` carry whatever a Step said, because a Step is Extension Point 2 and a
Project's or a Plugin's rule must be able to decline a purchase without teaching Core what its
reason means. Core maps its own reasons to statuses and answers 422 — "a Step this build of
Core does not know refused" — for everything else. Closing those two would close ADR-0003's
flagship.

**But a route where a Step can refuse still answers with reasons of Core's own**, and those are
promised by the table above whether or not a schema says so. `POST /store/orders` has twelve:
`place-order`'s own Steps refuse with seven, `resolve-price`'s two travel out of `price-lines`
as themselves, and the idempotency key turns a request back with two more before any Workflow
runs. So the set is not closeable and is not therefore exempt, and the answer is the strongest
one available rather than none:

- **Half-closing the schema is not available.** `anyOf: [enum, string]` generates as
  `"cart-empty" | string`, which *is* `string` in TypeScript — a client would receive a schema
  it could not narrow on, and the Step would lose the door.
- **So the words are listed in the schema's `description`, built from the constant rather than
  retyped**, and that constant is held to the three modules' own unions by the same mapped
  `satisfies` every closed set uses. A rename in `place-order.ts` turns `contract.ts` red
  naming the reason; a rename made consistently across both moves `openapi.json` and
  `@kobai/client`, where a reviewer sees it. That is strictly less than a closed set gives —
  no generated client can narrow on it — and it is the whole of what a set that must stay open
  can carry. It is written down here because "the two are separable" was the thing this design
  had to say rather than discover.

**What the compiler still cannot see is a body no route typed**, and that is where the second
bug was. `invalidRequestHook` answers `invalid` and `app.onError` answers `malformed-body`,
both at 400, and neither is checked against any route's declaration — so `malformed-body`
escaped `CartRefusal`'s and `PlaceOrderRequestRefusal`'s closed enums for as long as they have
existed. Verified over HTTP on `PATCH /store/carts/{id}`, `POST /admin/products` and `POST
/store/orders`, each answering `{"error":"Malformed JSON in request body","reason":"malformed-body"}`
at 400 against a schema that did not list it. Both enums now carry it, and
`packages/core/src/http/refusal-reasons.test.ts` sweeps **every operation the description says
takes a body**, sends one that will not parse and one that does not fit, and fails if the
`reason` that comes back is not in the enum that route declares — so the next route added
inherits the check rather than the bug.

## How this interacts with ADR-0058's pre-release licence

ADR-0058's licence is written about *promised surface*, so putting the HTTP surface under the
promise puts it under the licence too. Both halves follow, and both matter:

- **Until the first publish, this surface may be broken outright** — no deprecation window, no
  shim — provided the break is argued where it is made and recorded in an ADR. **This change
  is the first instance**, and takes it deliberately: narrowing a `reason` from `string` to an
  enum is a type-level narrowing that a storefront's exhaustive handling may not survive, and
  the shared `Refusal` component is referenced by no route any more and therefore leaves the
  description, taking `components["schemas"]["Refusal"]` out of `@kobai/client` with it. That
  second half was caught by the client's own build rather than by anybody noticing:
  `packages/client/src/index.ts` re-exports each schema by name "so that a name disappearing
  from the API is a build failure here", and it was. Both breaks are free today and neither is
  free after the release. Doing it now is the cheap version of a decision that only gets more
  expensive.
- **The licence closes for this surface at the same act it closes for everything else** — the
  deliberate removal of the loopback `publishConfig.registry` pin that
  `tests/publish-guard.test.ts` guards. There is now more riding on that one act, which is an
  argument for the guard rather than against the promise. **What else rides on it is
  [ADR-0061](./0061-what-the-first-publish-owes.md)**, the one list of what the first publish
  owes; this surface's licence closing is an entry on it, alongside the version rule #158 left
  behind and three obligations that have nothing to do with a promised surface (#162).

**But ADR-0058's second rule reaches this surface only partway, and the gap is the reason this
ADR exists rather than a footnote in that one.** "A break the Project's own compiler catches
is announced by the compiler" holds for a TypeScript storefront on `@kobai/client`: a removed
field or a renamed component fails its build. It says nothing to the Ruby storefront ADR-0006
rejected tRPC in order to permit, and until this change it said nothing to *anybody* about a
`reason`, because no compiler was watching one. So **an HTTP break carries the written notice
regardless of whether a compiler would speak** — which is what ADR-0059 was doing by hand when
it wrote down two reason strings and observed that nothing was watching them.

## Considered and rejected

- **Leave the surface unpromised and say so.** Consistent with a strict reading of ADR-0019,
  and it makes ADR-0002 false and ADR-0010 incoherent: the API cannot be "the product" for a
  storefront Developer while being changeable without notice, and forcing the Admin onto a
  surface nobody may rely on is a rule with no purpose.
- **Promise the paths and the shapes but not the reasons.** The tempting half-measure, and it
  promises the envelope and not the letter. `reason` is the field kobai's own schema tells a
  client to branch on and `error` is explicitly not for programs, so a client that may not
  depend on `reason` has been given a refusal it cannot act on. ADR-0040 had already refused
  this for one body; there is no principle that would keep it to one.
- **Make it a sixth Extension Point.** ADR-0047's argument, applied again: the list is
  runtime attachment points that shape Core's architecture, and this shapes none of them.
- **Narrow every `reason`, including the two a Step produces.** It closes the flagship
  Extension Point and it is not expressible in a generated client anyway.
- **A schema per operation per status.** More precise, and it compiles — the assumption that
  it would not was tested and was wrong. Rejected on the three grounds above: it departs from
  `CartRefusal` for no reason, it multiplies promised component names fivefold, and the
  precision is already in the per-status prose each route carries.
- **Version the surface in its path — `/v1/admin/…`.** A real option and a bigger decision
  than this one: it is a second axis of compatibility to maintain, it doubles what a Project
  serves the day a `/v2` exists, and ADR-0024 has kobai shipping one release target. Deferred
  rather than rejected — the day kobai needs to serve two shapes at once, this is where to
  start.

## Consequences

- **A refusal is now designed, not emitted.** Adding one to Core means adding it to the
  module's own union and to the enum in `http/contract.ts`, which the compiler asks for. The
  cost is real and is the point: a reason string is now as hard to change as a response field,
  because it always was for whoever was branching on it.
- **`Refusal` is gone from the description**, replaced by `InvalidRequest`, `MerchantRefusal`,
  `CatalogRefusal` and `ApiKeyNotFound`. Taken under ADR-0058's licence, and it is the last
  moment such a rename is free.
- **`AGENTS.md` § The API contract is where this becomes an instruction, and the edit was owed
  rather than made here.** That section described how the description is *kept honest* and said
  nothing about what changing it costs; and its one sentence about reason strings — "it stops
  at the status: the `session-*` and `api-key-*` *reasons* inside a `401` are pinned one level
  down, by the mapped `satisfies` on `SESSION_REASONS` and `API_KEY_REASONS`" — described two
  of the closed sets rather than the only two there were. Both changes were held back
  deliberately: the file was another ticket's while this was written, and a half-edit to the
  single source of truth is worse than a pointer. **#157 made them**, and the reason-strings
  sentence now describes the construction rather than counting the sets, which is ADR-0049's
  lesson about a number in prose applied to this one.
- **`docs/extension-points.md` was owed the same edit, and for a sharper reason.** Its second
  section was headed "Core's semver covers these five and nothing else" and its third lists
  what is not promised — and it is the page a Developer is *sent to* to find out what they may
  lean on, so it is the one place this record's absence would still mislead somebody after
  this record exists. It was another ticket's file the day this was written, hence a pointer
  rather than an edit; **#157 made it**, and that section now carries the called-versus-consumed
  argument and names all three things semver covers.
- **ADR-0019 and ADR-0003 gain a second amendment note each**, pointing here, so a reader
  looking for "what is under semver" finds all three answers from either end.
- **The description now names the release it describes** — the one thing here that has already
  moved. This record left `info.version` at `"0.0.0"`, with `app.ts` claiming beside it that the
  value moved with `@kobai/core`'s, and called closing that a decision nobody had taken. #158
  took it, hours later and for this record's own reason: a consumer holding an `openapi.json`
  has no manifest beside it, so a promise it cannot date is a promise it cannot use. `coreVersion()`
  reads the manifest where the document is built, so the surface's version *is* the package's
  rather than a second copy kept by hand, and `openapi.test.ts` fails when the checked-in
  artifact and the manifest disagree. The consequence to know is a workflow one: **a version
  bump has to regenerate `packages/core/openapi.json` in the same commit**, while
  `packages/client/src/schema.ts` does not move at all, because `openapi-typescript` emits no
  `info` block.
- **ADR-0059's two refusals are no longer promised in prose alone.** That record said the
  question of whether they get "the enum treatment" was a decision nobody had taken. This is
  it, and they got it.
