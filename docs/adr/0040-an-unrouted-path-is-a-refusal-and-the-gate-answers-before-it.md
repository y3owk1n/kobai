# An unrouted path is a refusal like any other, and the gate answers before it

kobai answers a path no route serves with the same JSON body every other refusal uses —
`{ error, reason: "not-found" }` at 404 — from one `app.notFound` handler covering the whole
application. The handler is not a route, so it is absent from the OpenAPI description, and it
runs *after* both surfaces' credential gates, so an anonymous caller is never told whether a
path exists.

Before this, only `/store` did that; `/admin` and the root fell through to Hono's plain-text
404 (#33). Under ADR-0006 that is not a cosmetic inconsistency: `packages/core/openapi.json`
is generated from the implementation and `@kobai/client` from that, so two error shapes leave
a generated client either modelling both — pushing the inconsistency out to every storefront
author — or modelling one and lying about the other.

## What is decided

- **One shape, one handler.** Not one catch-all per surface. A typo at the root is the same
  mistake as a typo under `/admin`, and a Project hands kobai every path it does not serve
  itself (ADR-0010), so the surface that must answer in one shape is all of it. The store's
  own wildcard was removed in favour of this; its behaviour is unchanged.
- **`reason` is `not-found`**, the word `/store` already used and the one
  `reference/src/admin-assets.ts` uses for a missing Admin asset.
- **A method a path does not serve is reported as a path that is not there.** Distinguishing
  the two would mean enumerating the methods of every path, and the description already
  enumerates them for anyone who needs the list.
- **It is not in the description.** A description enumerates the paths that exist; this
  answers the paths that do not. So a generated client has no type for this body — which is
  consistent rather than a gap, because it also has no way to make the call that produces one.

## Information disclosure: where the line is

Two questions, and they get different answers.

**Does a path exist?** Not answerable anonymously, on either authenticated surface. Both
gates are mounted with `use("*")` and therefore run before routing, so an unauthenticated
request to a nonexistent `/admin` path is answered 401 by the session gate and never reaches
the not-found handler; `/store` answers 401 the same way. That ordering is deliberate and is
kept: it is the same property that keeps the description unserved (`http/openapi.ts`), and it
means an anonymous caller cannot map either surface by watching which paths 404 and which
401. A 401 that came *after* routing would turn every gate into a path oracle.

**Does a route exist that this Merchant may not call?** Answerable, once you are through the
gate — a signed-in Merchant whose Role is too narrow gets 403 on a route that exists and 404
on one that does not. That is accepted, because the route set is not a secret: it is
identical in every deployment, generated into `packages/core/openapi.json`, and shipped in
`@kobai/client`. Hiding a 404 behind a 403 would buy no secrecy and cost a real diagnostic —
a Developer could no longer tell a typo from a permission they lack. What *is* kept secret at
that boundary is which **rows** exist: `requirePermission` answers before the handler runs, so
a Merchant without `catalog:read` learns nothing about whether the Product in the path is
there (ADR-0027, pinned in `catalog.test.ts`).

## Consequences

- The 404 body is now part of what kobai promises, and is asserted beside a gate refusal in
  `packages/core/src/http/app.test.ts` — field names and content type compared against each
  other rather than against a remembered literal, so the two cannot drift apart.
- A route added under a gate inherits the ordering for free; a surface mounted *without* one
  would answer 404 anonymously, which is the thing to notice when a third surface appears.
- Changing the shape or the `reason` later is a breaking change to the contract, the same as
  changing a declared response — even though no route declares this one.
