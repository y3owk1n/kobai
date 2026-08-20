# The Playground attaches its credential, and omits the ambient one

**Every request the Playground sends carries a credential chosen on the screen** — *this
Merchant's Session*, *a publishable key*, or *a secret key pasted for this request*. When the
choice is anything but the Session, the request is sent with **`credentials: "omit"`**, so the
browser's `kobai_session` cookie does not ride along uninvited.

There is **no sandbox**: a deletion sent from the Playground deletes. What stands between a
Developer and that is not a test mode but three narrower things — the credential is always
explicit, a non-`GET` on the *Session* credential must be armed, and the two session operations
are not offered at all.

## Why `credentials: "omit"` is the whole of it

This is the load-bearing line, and without it the screen is worse than useless.

`kobai_session` names no `Path`, so RFC 6265 files it under the default-path `/admin` and the
browser attaches it to every request to that subtree
([ADR-0032](./0032-merchant-sessions-travel-in-an-httponly-cookie.md)) — regardless of which page
sent it, and regardless of any `Authorization` header the sender also set. So a Developer who
selects a publishable key and sends `GET /admin/products` gets **200 and a list of Products**,
and learns that a `kobai_pk_…` opens the admin surface. It does not. The tool would be
confidently answering a different question from the one being asked, which is the failure mode a
playground exists to remove.

With the cookie omitted, the inverse becomes true and valuable: a `/store` call made with a
publishable key behaves **exactly** as a storefront's would, including failing the same way.
`POST /store/orders` answers `secret-key-required`, and
[ADR-0055](./0055-placing-an-order-requires-a-secret-key.md) stops being a paragraph in a document
and becomes something a Developer met. That fidelity — *this is what your storefront will get* —
is the entire reason to build the screen.

It is also what answers the concern that first argued for a separate app. Isolation could not come
from a second origin ([ADR-0079](./0079-the-admin-takes-a-second-audience-and-it-is-one-app.md)
has why), so it comes from the request instead: the ambient credential is present only when it was
selected.

## Why `/admin` gets no bearer credential — for now

The natural symmetry is to attach a key to *both* surfaces, which means inventing a **Merchant
access token**: minted by a Merchant, bound to them, inheriting their Role, shown once like an API
key, sent as a bearer. It is a real and useful thing, and it is deferred rather than refused —
but it must not arrive *here*, because in this context it inverts its own justification.

The Merchant session is `HttpOnly`. No script in the Admin can read it; an XSS in a vendored
component cannot exfiltrate it. A minted admin token that the Playground carries would live in
`sessionStorage`, where any script can read it. **Introducing a credential to protect credentials
would move the admin credential from somewhere unreadable to somewhere readable** — the precise
trade ADR-0032 refused when it took the session token out of a response body, arriving again by
a different door.

Its real beneficiary is a Developer at a terminal: `curl`, a CI job, the CLI ADR-0079 defers. A
token in a shell's environment is in the place such a thing belongs, and `@kobai/client`'s own
docblock already describes the awkward workaround it would replace — *"a server-side script
driving `/admin` signs in and keeps the cookie itself, the way a browser does."* That is a ticket,
with its own expiry, revocation and audit questions to answer.

**Letting secret API keys open `/admin` was the cheap version and is refused outright.** An API
key belongs to a deployment and carries no Role, so admitting one to the admin surface means
admitting it with every Permission or with none. The first is a root credential that makes every
storefront's secret key an admin key and contradicts
[ADR-0066](./0066-administering-access-is-one-permission-and-the-last-administrator-cannot-be-removed.md)'s
entire model; the second is a credential that opens a surface it can do nothing on.

## What may be pasted, and what may be stored

- **The publishable key is the one that already exists.** `lib/preview-key.ts` mints and holds a
  `kobai_pk_…` in `sessionStorage` for the storefront price preview, with a written argument for
  why only a publishable key may go there. The Playground uses **that** key and that module. Two
  self-minting mechanisms would double an accumulation the module already apologises for, and a
  Merchant reading the API keys list wants one line meaning "the Admin itself", not two.
- **A secret key may be pasted, and is held in memory only.** Never `sessionStorage`, gone on
  reload, with the consequence stated at the field. The rule ADR-0055 and
  [#214](https://github.com/y3owk1n/kobai/issues/214) actually protect is that **the Admin never
  mints and never stores a secret key** — not that no such value may ever exist in the tab. A
  Developer testing `POST /store/orders` needs one, it is their own credential, and typing it is a
  deliberate act whose lifetime ends at the next reload.
- **The *choice* persists; the values persist as they each deserve.** Which credential is selected
  survives a reload, the publishable key survives because it always did, and the pasted secret does
  not. The reload behaviour teaches the distinction instead of hiding it.

## Arming, and the two operations that are not offered

**A non-`GET` sent on the Session credential must be armed first**, per session. The blast radius
that matters is the ambient one: the Session is the credential nobody had to type, carrying the
Role the Merchant actually works with, against the real Store. A pasted key is a deliberate act
every time and needs no guard — guarding it would be ceremony around the safe case while the
dangerous one stayed the default.

Arming is an **affordance and never a boundary**, the same way every permission check in the Admin
is ([ADR-0063](./0063-the-admins-frame-is-conventional-because-a-developer-inherits-it.md)), and
the code should say so at the line. Core is what enforces; this stops an experiment becoming a
mutation by accident.

**`POST /admin/session` and `DELETE /admin/session` are not offered.** This is the one exception to
the rule that the Playground offers everything and lets Core answer, and the difference is exact:
Core would not refuse these, it would **obey** them, correctly. Signing out logs the Merchant out
of the tab they are standing in; signing in replaces the session in the one cookie jar the origin
has, so a Developer would become somebody else in the Admin behind the screen. Every other
operation has a blast radius of one record; these two have a blast radius of the session doing the
asking, and no app boundary can fix that.

**Everything else is offered, including what the selected credential cannot do.** The Admin's
standing rule is that nothing predicts a refusal — there is no `canDelete` prop
([ADR-0059](./0059-catalog-deletion-refuses-rather-than-cascading-or-releasing.md)) — and hiding
the operations a publishable key cannot reach would require the Admin to hold a second copy of
which routes need which key, which is the closed-set-in-the-client mistake ADR-0067 exists to rule
out.

## The clashes excluding two routes does not cover

Excluding the session operations removes the two ways to end the session *directly*. Three
others remain, and they are accepted rather than fixed — named here so the next person does not
read the exclusion as a claim that the Playground cannot disturb the tab it lives in.

**An operation can target the Merchant using it.** `PATCH /admin/merchants/{id}` on your own id,
or `PATCH /admin/roles/{id}` on the Role you hold, takes your own access away while you are
standing in the Admin. Core's refusals here protect the **deployment** and never the **actor**:
`last-administrator` means a lone Developer is refused outright, so the worst reachable outcome
needs a colleague to undo and cannot lock a deployment out. They are **not** excluded, because
unlike the session routes they are ordinary operations a Developer has a real reason to exercise,
and a Playground that hides them lies about the API. Detecting them would mean the Admin parsing
path parameters against the session to enforce a rule Core does not have.

**Work done on another credential does not feed the idle window.** A session's deadline advances
when a request presents it, at most once a minute; a request sent with `credentials: "omit"`
presents nothing. So a Developer exercising `/store` with a pasted key, without navigating or
leaving the tab, can be signed out **while busy** — the one clash this record's own decision
creates. It is accepted because the frame already answers it:
`tests/the-admin-in-a-browser.test.ts` asserts a session running out mid-use and the Merchant
landing back where they were, and the Playground is a screen like any other.

**Keeping the session alive while the Playground is open is refused**, and it is the tempting fix.
A tab that feeds its own session is a tab that never idles out, which deletes
[ADR-0045](./0045-sessions-expire-on-inactivity-under-an-absolute-cap.md) from a screen rather
than from a config.

## What survives a re-sign-in

That acceptance has a cost, and it is paid where a Developer notices: re-signing in mid-use
remounts the screen. **The composed request — the chosen operation, its parameters and its body —
lives in the address**, so it survives that, a refresh, and the browser's back button, and can be
sent to a colleague as the call that reproduces a problem. It is the rule the rest of the frame
already follows, where the list cursor and every filter are in the URL
([ADR-0064](./0064-list-pagination-is-a-cursor-and-the-page-number-is-given-up.md)).

**The pasted secret key is not**, and must not be. It is memory-only by the decision above, so a
re-sign-in loses it and the Developer types it again — which is the correct outcome and not a gap
to close later. A secret key in an address is a secret key in a browser history, a proxy log and
whatever the colleague it was sent to does next.

## Nothing validates before sending

Path and query parameters are real form fields, built from the description
([ADR-0080](./0080-a-deployment-describes-itself.md)); the body is a textarea seeded from the
request schema. **The body is not checked in the browser.** `InvalidRequest` is modelled and
promised under ADR-0060, so a refused body renders the real rule from the authority that owns it —
and a JSON-Schema form renderer would be both the most bespoke thing in an Admin whose frame is
deliberately conventional, and a second implementation of a rule that lives in Core.

## The cast, and where it is allowed to be

`openapi-fetch` types every call against a **literal** path, so a path read out of a runtime
document cannot typecheck. A playground driven by a runtime description is inherently not
compile-time typed, and some cast is unavoidable.

It lives in **one file in the Admin** — the Playground's request seam — and not in
`@kobai/client`. That package's wrapper says of itself that it exists to do "the one thing the
description cannot express — attach a credential — and nothing else", and
[ADR-0006](./0006-typescript-on-node-with-a-rest-openapi-contract.md) sells the client on every
call it types being a call that exists. An untyped `raw()` on it is a hole every consumer inherits
to serve one screen.

`tests/admin-uses-only-the-public-api.test.ts` gains a third assertion naming that file as the
only one permitted to construct a kobai path at runtime. Its existing scan reads **quoted** path
literals, so without this it would be silently vacuous over the one screen in the Admin that can
reach anything — a guardrail that passes by not looking.

## Considered and rejected

- **A separate app, so credentials are not shared.** Isolates nothing on one origin and deletes
  `/admin` on two. ADR-0079 has the cookie argument in full.
- **A Merchant access token, now.** Moves the admin credential into script-readable storage. Good
  idea, wrong beneficiary, its own ticket.
- **Secret API keys open `/admin`.** A root credential by construction.
- **A test mode or a sandboxed dataset.** kobai has one Store per deployment
  ([ADR-0005](./0005-single-tenant-with-first-class-channels-and-regions.md)); a sandbox would be
  a second one, which is multi-tenancy smuggled in through a developer tool.
- **Arm every non-`GET` whatever the credential.** Ceremony on the safe case; the tedium is how a
  safety feature gets removed.
- **Confirm each write with its method and path.** Same, worse.
- **Validate the body in the browser.** A second copy of Core's rules, in the tree kobai cannot
  upgrade.
- **Leave the cookie attached.** The screen would answer a different question from the one asked,
  which is the only outcome worse than not building it.

## Consequences

- **A Developer can delete a real Product from the Admin in two clicks, having armed it.** That is
  the accepted cost of a playground against a real deployment, and it is stated on the screen
  rather than mitigated.
- **The Playground is the only place in the Admin that constructs a path at runtime**, and one
  test says so.
- **A publishable key revoked in the API keys screen breaks the price preview and the Playground
  together**, since they share one key. The existing "your key was revoked, ask again" recovery is
  what the Playground inherits.
- **`credentials: "omit"` makes the Playground a genuine storefront simulator for `/store`**, which
  is worth more than the isolation it was chosen to provide.
- **A Developer can take their own access away from the Playground**, and get it back from a
  colleague. `last-administrator` is what stops that being a deployment nobody can administer.
