# A Merchant's Role is corrected in place, and a Merchant is still never removed

`PATCH /admin/merchants/{id}` moves a Merchant onto another Role, by name, behind
`merchant:write`. It refuses **422 `last-administrator`** when the Merchant is the only one who
can administer Merchants and the Role named cannot, and it is the **only** thing about a
Merchant this API will change: there is no `email` on that body, no `password`, and no
`DELETE /admin/merchants/{id}`.

## Why this was open

[ADR-0059](./0059-catalog-deletion-refuses-rather-than-cascading-or-releasing.md) chose
refusal over cascading and over reassigning, and the sentence that carries it is *"the repair is
one a Merchant can carry out themselves"*.
[ADR-0066](./0066-administering-access-is-one-permission-and-the-last-administrator-cannot-be-removed.md)
applied that to Roles: `DELETE /admin/roles/{id}` answers `role-in-use` while any Merchant holds
the Role, and points at `GET /admin/merchants` for who they are.

**Nothing could make any of them stop holding it.** `POST /admin/merchants` was the whole of
what wrote `core_merchant`, so `role-in-use` was not a step but a wall — permanent for as long
as those Merchants existed, which is for ever. ADR-0059's promise was not being kept on this
table, and ADR-0066 had already noticed the shape of the gap in as many words: whoever added a
route that moved or removed a Merchant would inherit the lockout invariant *"in the harder
form"*.

It surfaced where ADR-0010 says such things surface — writing the Admin (#180, #202). Two drafts
of the `role-in-use` message told a Merchant to move the holders off first, and both had to be
rewritten to say kobai could not, which is honest and is not a good place to be left.

## What is decided

- **A Merchant's Role is correctable in place**, which is
  [ADR-0062](./0062-a-variant-is-corrected-in-place-and-a-price-is-superseded.md)'s shape
  arriving at one more table. An absent field means "leave it"; a body naming nothing this route
  would change is refused at 400 with the sentence every other correction shares; naming the
  Role they already hold is a 200, exactly as `PATCH /admin/store` accepts the currency it
  already prices in. `role` is `optional` in the schema **although it is the only field**,
  because the emptiness is a rule the handler answers rather than a schema violation the edge
  reports in its own words — required, this would be the one correction on the surface that
  refuses a no-op differently from the rest.

- **The Role is named by name**, as `POST /admin/merchants` names it. One surface should spell
  one thing one way, and what it costs is `unknown-role` at 400 for a Role renamed between a
  picker being filled and the submit — a race rather than a typo, and the same word and the same
  status the create route already answers it with.

- **It takes `merchant:write` and needs no Permission of its own.** ADR-0066's transitive
  argument covers it: a Merchant who may add a colleague may add one against `owner`, so that
  Permission is already the power to administer access entire, and moving a colleague between
  Roles confers nothing it did not.

- **`last-administrator` is the same word here as on the Role surface**, and that is the
  decision rather than a convenience. It names one fact about a deployment — that nobody would
  be left holding `merchant:write` — which two different acts can now bring about. A second word
  would make a client branch twice on one state, and neither branch could act differently.

- **The guard is one module and one advisory-lock key**, `auth/administrators.ts`. This is the
  half that is easy to get wrong and expensive to discover: two *correct* guards on two keys
  serialise nothing against each other, so a strip and a move each read the other's
  administrator, both pass, and both commit — the exact lockout, arrived at through two changes
  that each refused to cause it alone. The condition is about **other rows**, so ADR-0018's
  one-statement answer does not reach it; the lock is taken before the read and held to commit,
  as ADR-0066 already required of the first route.

  The two questions underneath it are deliberately **two functions**. Narrowing a Role asks
  whether any Merchant *outside that Role* still administers, because every holder loses the
  Permission together; moving a Merchant asks whether any Merchant *other than that one* does,
  because their colleagues on the same Role stay exactly where they were. Asking the Role
  question of a move would report a lockout for a deployment with three administrators on one
  Role.

## What is deliberately not decided

- **A Merchant is still never removed.** `DELETE /admin/merchants/{id}` raises questions nobody
  has answered — what becomes of their live sessions, whether an Order they touched still reads
  back (ADR-0009), and whether `core_merchant.role_id`'s `on delete restrict` is still the right
  key — and none of them is what `role-in-use` needed. ADR-0066's note stands for whoever takes
  it: the guard is already in one place with one key, and a third act reaching this invariant
  extends `administrators.ts` rather than copying it.

- **An address and a password are not correctable over this API at all.** Moving the credential
  a colleague signs in with, and setting somebody else's password from your own session, are two
  more decisions, and a `PATCH` that carried them would have taken both in passing. The no-op
  refusal says so rather than leaving the absence to be inferred, which is the second job
  ADR-0062 gives that refusal.

- **Nothing about how a Role is *chosen* moves.** A Permission Core has never heard of is still
  stored rather than refused, the writes are still one Permission, and `DELETE /admin/roles/{id}`
  still refuses rather than cascading or reassigning. What changed is that its advice now names
  a control that exists.

## Consequences

- **`merchant-not-found` and `last-administrator` join `MerchantRefusal`**, which widens what
  `POST /admin/merchants` declares it can answer even though it can answer neither. That is the
  house shape — `RoleRefusal` is one closed set across four operations and each route declares
  its own statuses — and under
  [ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md) a new
  `reason` turns an exhaustive `switch` over a regenerated `@kobai/client` into an incomplete
  one, so it is owed a note in the release.
  [ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md)'s licence is
  what makes it free today.

- **The race test dispatches at both routes**, and getting it to fail against a build with two
  keys took an arrangement change worth knowing about anywhere in this repository: `pg.Pool`
  opens a connection on demand, so two requests dispatched together against a pool with one idle
  connection do not overlap — the first has committed before the second has finished connecting.
  A concurrent warm-up before the race is what puts them in the same millisecond. An arrangement
  that quietly stopped overlapping looks exactly like a fix, which is
  [ADR-0049](./0049-migration-counts-are-derived-and-the-strength-moved-to-the-effect.md)'s trap
  wearing a race's clothes.

- **The Admin's roster grows a control per row**, and two sentences that had to say kobai could
  not do this now name the screen that does.
