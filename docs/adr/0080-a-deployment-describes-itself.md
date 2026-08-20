# A deployment describes itself

**Two routes, both behind a new `deployment:read` Permission, and neither pages.**

- **`GET /admin/openapi.json`** answers this deployment's own OpenAPI description — the value
  `kobai.openapi()` already produces, which until now was generated at build time and never
  served.
- **`GET /admin/deployment`** answers what *nothing else* answers: the version of Core this is,
  each declared Workflow's positions with the **provenance** of the Step in each, and whether a
  Payment Provider is configured. It carries neither the Fulfilment Strategies nor the migration
  sets, because `GET /admin/fulfilment-strategies` and `GET /health` already do.

This is [ADR-0010](./0010-the-admin-ships-in-one-container-and-gets-no-private-api.md)'s
mechanism working as designed for the second time: a gap found while building an Admin screen
([ADR-0079](./0079-the-admin-takes-a-second-audience-and-it-is-one-app.md)) surfacing as a finding
about the public API, exactly as [ADR-0067](./0067-a-set-the-deployment-declares-is-not-a-list-route.md)
did.

## Why the description has to be served, and not bundled

The reason is narrower and harder than "the client might be out of date", which was the first
answer and is not the real one.

**`@kobai/client`'s `schema.ts` is types.** It is `openapi-typescript` output — six exported
interfaces and no runtime value anywhere in the file. TypeScript erases every one of them at
build. So the Admin, which reaches kobai *only* through that client, holds **no description at
runtime at all**: it has compile-time knowledge of every path and zero bytes of it in the bundle.
A screen that renders one operation's parameters, or builds a form from a request schema, has
nothing to read.

That leaves two ways to get a document into the browser, and only one of them is allowed:

- **Import `@kobai/core/openapi.json`.** It is a real file and it is exported under that
  specifier. But `docs/agents/the-admin.md` bans importing `@kobai/core` from the Admin outright,
  and the ban is right here for a reason beyond its usual one: that file is a **package's build
  artifact**, and what the screen needs is **this server's answer**. Shipping a server's
  description inside a client is a copy that can be wrong, and in a Project it is the copy kobai
  cannot fix — the Admin is vendored source
  ([ADR-0033](./0033-the-admins-shape-a-vendored-vite-spa-at-a-path.md)) that
  `kobai-upgrade` never reaches, and `@kobai/client` and `@kobai/core` are two independently
  pinned dependencies in a lockfile the Developer owns.
- **Ask the server.** Which is this record.

**What it does *not* fix, so nobody expects it to:** the description covers kobai's surface and
not the Project's. `reference/src/app.ts` mounts this Project's payment routes at `/payments/…`,
deliberately outside `/admin`, `/store` and `/health`, and `reference/src/app.test.ts` asserts
that the Project adds no route to kobai's API at all. A Project's own routes are not kobai's to
describe and this route does not describe them.

## Why it reverses "not served over HTTP", and why that is not a reversal

`Kobai.openapi()`'s own docblock says it is *"Not served over HTTP — `/store` refuses an
unauthenticated request before saying whether a path exists, and an endpoint handing out the whole
surface anonymously would undo that."*

**Read the objection precisely: it is to *anonymously*, not to *served*.** Behind
`deployment:read` on the admin surface, a caller has already presented a Merchant session and been
found to hold a named Permission. Nothing about `/store`'s refusal-before-existence is undone,
because nobody reaches this without credentials that `/store` never accepts in the first place.
That docblock is amended rather than contradicted, and it is amended in the same commit — a
sentence in Core saying a thing the API now does is the failure
[ADR-0071](./0071-a-cart-is-listable-and-a-merchant-may-place-an-order-on-behalf.md) caught on
`core_cart`'s schema comment and made a rule about.

**Unauthenticated at `/openapi.json` was the obvious alternative** and is refused. It is what most
APIs do, and it publishes to anyone who asks which routes a deployment serves, which gates they
sit behind and which refusals they make. That is a decision about a *Project's* exposure, and
kobai should not take it on a Developer's behalf as a default. A Developer who wants it public
can serve it from their own route in three lines, which is the right way round.

That this repository has just opened a route no credential opens —
[ADR-0078](./0078-media-bytes-come-from-the-storage-and-kobais-own-route-is-open.md)'s
`GET /media/{key}` — is not the precedent it looks like, and the difference is worth stating
because the two records land in the same week. A Media byte is a **published product image**: it
is already on a storefront, an `<img src>` cannot present a credential, and gating it would break
the one use it has. A description of the whole surface is the opposite kind of thing — nobody's
storefront renders it, and what it discloses is the shape of an attack surface rather than a
picture a Shopper is meant to see. The question is never "is an open route allowed here", it is
"what does this particular route give away, and to whom".

**The body is an open object.** An OpenAPI document is a recursive schema, and modelling it in
zod would be a second, worse copy of a specification kobai does not own — for a value every
consumer feeds to a tool that already knows the shape. It is described in prose in the contract,
the way `OpenMetadata` is.

**It describes itself.** `GET /admin/openapi.json` appears in the document it returns. A
description whose first omission is the route serving it is a document that lies about the server
on the one fact it is best placed to know.

## Why provenance is recorded rather than inferred

`GET /admin/deployment` reports, per Workflow, each position's slot and the name of the Step in
it, **and whether that Step is `stock`, `replaced` or `inserted`**. The last part cannot be
derived after the fact, and the trap is worth writing down because the inference looks sound.

`WorkflowStep` is `{ slot, step }`, where the slot is stable across a swap and `step.name` is
whatever the implementation calls itself. For a Core default the two agree — and `insertedAt`
gives an inserted Step `slot === step.name` as well, because an inserted Step occupies a position
under its own name. So **name-equality reads an inserted Step as stock**, and it reads a
replacement that happens to reuse the slot name as stock too. Both mistakes are confident and
silent, and both land on the flagship Extension Point
([ADR-0003](./0003-the-extension-surface-and-what-we-promise.md)) — the one question about a
kobai deployment that is always worth asking.

`rewireWorkflow` is the one place that holds both the stock declaration and the result, so it is
where the answer is known for free. Recording it there is a field on a Core-internal type; deriving
it anywhere else is guesswork.

## Why not one aggregate route

`GET /admin/deployment` deliberately does **not** carry the Fulfilment Strategies or the migration
sets. Both are already answered — by ADR-0067's route, built for a picker, and by `GET /health`,
built for a container probe. Restating them here would be two descriptions of one fact that can
disagree, and the screen composing three reads is cheaper than the surface carrying a duplicate
forever under [ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md).

**It does not page**, and it is the second route on that side of ADR-0067's boundary: a set fixed
by the deployment's own configuration, readable in full, unable to change without a restart.
`GET /admin/openapi.json` is not a list at all.

## `deployment:read`, and only read

A new Permission string, appended to `PERMISSIONS` and to the seeded `owner` Role by a migration,
in that order, because a test asserts `owner` equals `ALL_PERMISSIONS` exactly.

**There is no `deployment:write`, and there will not be one from here.** Everything this reads is
decided by a file a Developer edits and a process restart — there is nothing on this surface to
gate a write against. That makes it the second Permission with one half, beside `order:read`, and
for the same kind of reason.

**Not a second use of `store:read`.** A Store is the commercial identity — its name, its metadata,
its enabled currencies. A Role granted that so somebody could correct a currency would otherwise
silently also see which Steps this deployment has replaced. Every other pair on this surface
splits on exactly that argument.

## Considered and rejected

- **Bundle `openapi.json` into the Admin.** Breaks the `@kobai/core` import ban, and ships a
  package build artifact as though it were a server's answer.
- **Serve it unauthenticated at `/openapi.json`.** Publishes a Project's surface by default.
- **Put the version on `/health` instead.** `/health` is shaped so a container probe can act on
  `status` alone, and it is the one route that answers before migrations apply. Widening it for a
  human's benefit costs the probe's simplicity and gains a fact nobody probing wants.
- **Infer `replaced` from `slot !== step.name`.** Wrong in both directions, silently.
- **One aggregate route carrying everything.** Two descriptions of one set.
- **Report installed Plugins.** Core has no such notion and
  [ADR-0017](./0017-plugins-offer-steps-and-the-project-wires-them.md) is why: nothing takes
  effect by being installed. A list of installed Plugins would name packages that are importable,
  wired to nothing, and completely inert — which is the exact confusion that record was written
  against. What a deployment *has done* is its migration sets, its Strategies and its Steps, and
  those are what is reported.

## Consequences

- **Both routes are promised surface** under ADR-0060, including which gate they sit behind.
  Loosening `deployment:read` later is a break, not a tweak.
- **The version is `coreVersion()`, which already exists.** `http/app.ts` reads it from Core's own
  manifest to fill the description's `info.version`, on ADR-0060's reasoning that the surface's
  version *is* the package's. This route is a second reader of that one fact rather than a second
  copy of it — which is the same argument, one route along.
- **Two written statements that the description is not served change** in the same commit as the
  route: `Kobai.openapi()`'s docblock, and the paragraph of the same name in
  `docs/agents/the-http-surface.md`. Both carry the anonymity argument, and both are amended
  rather than deleted — the surface is still not served *anonymously*.
- **`@kobai/client` gains a path and a type** by regeneration, like every other route.
- **A Merchant holding only `deployment:read` can read the whole shape of the API and nothing in
  it.** That is the intended grant, and it is what makes the Playground safe to *show* to a Role
  that can do very little — see
  [ADR-0081](./0081-the-playground-attaches-its-credential-and-omits-the-ambient-one.md).
