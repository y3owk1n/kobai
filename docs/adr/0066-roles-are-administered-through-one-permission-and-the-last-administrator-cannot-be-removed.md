# Roles are administered through one Permission, and the last administrator cannot be removed

`POST`, `GET`, `PATCH` and `DELETE /admin/roles` create, read, change and remove a Role, and
`GET /admin/merchants` says who holds which. Six operations, all of them new promised surface
under [ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md)
from the day they ship.

[ADR-0027](./0027-holds-roles-and-bundles-re-decided-on-platform-terms.md) settled the model —
named Roles carrying **permission sets**, never per-resource ACLs — and until #173 it was real
in the schema and reachable from nowhere else. Exactly one Role existed, seeded by
`packages/core/migrations/0003` with every Permission bolted onto it by later migrations, and no
route made another; Core's own tests wrote `insert into core_role` with a comment saying *"Roles
are rows, so a narrower one is a row"*, which was true and was the finding. Every deployment had
one kind of Merchant, holding everything.

Most of these six routes need no record: they are ADR-0064's pagination and ADR-0062's `PATCH`
applied to one more table. Four things about them are decisions, three are hard to reverse, and
this is where they are written down.

## A Permission this build of Core has never heard of is preserved, not rejected

**Decided: `permissions` is an array of strings and nothing checks which strings.** Each entry
must be a non-empty string — a shape, not a vocabulary — and is stored and answered back
unchanged.

The alternative was there for the taking, and it looks like ordinary rigour: `PERMISSIONS` in
`auth/permissions.ts` is a closed literal of the eight words Core defines, and refusing anything
else would catch a typo the moment a Merchant made it. It is still wrong, for two reasons that
outlast the typo.

**The `Session` schema already promises otherwise, one field away.** `RoleSummary.permissions`
carries the description *"A deployment may hold a permission this build of Core has never heard
of"*, which is in `openapi.json` and in every generated client. Validating against Core's own
set would make that sentence false while leaving it published.

**And it forecloses a Plugin's Permission before anybody has designed one.** ADR-0027 says a
Permission is *a string*, and `CONTEXT.md` says the model is additive — "a new Permission is a
new string, not a new structure". A Plugin that serves routes of its own will want a word to
gate them with, and under a closed set the only way to get one would be a release of Core.
Nothing in this ticket designs that mechanism, and a closed set would have decided against it
without anybody noticing. Refusing later is cheap; accepting later is a break.

The cost is real and is accepted: `catalog:reed` is stored, and the Merchant finds out by being
refused a route rather than by being refused the Role. What answers that is the Admin — a
Permission picker offering the words the deployment actually gates on (#178) — which is an
affordance, exactly where ADR-0063 says one belongs.

## The last Merchant who can administer Merchants cannot be stripped

**Decided: a change to a Role's `permissions` is refused at 422 `last-administrator` when it
would leave no Merchant holding `merchant:write`.**

This is a lockout, not a preference. A deployment that reaches that state has nobody who can put
the Permission back, and nobody who can sign a colleague up to try — the first Merchant is
seeded once at boot and only while there is none
([ADR-0041](./0041-the-first-merchant-is-seeded-at-boot.md)), so a database with a Merchant
already in it is never seeded again. The way back is `UPDATE core_role`, which is exactly the
state this surface exists to remove.

The condition is precise, and each half of it matters:

- **Held, not merely written.** A Role carrying `merchant:write` that no Merchant holds protects
  nobody, so it is not a rival. The check joins `core_merchant`.
- **Only when the change removes it.** A Role that never had `merchant:write`, or that keeps it,
  is not asked about — so renaming the `owner` Role, or editing its metadata, is an ordinary
  200.
- **Only when there is something to lose.** A deployment that already has no administrator
  cannot be repaired by refusing changes to it, so the refusal is conditional on some Merchant
  holding the Permission now. Refusing there would freeze the damage rather than prevent it.

**Deleting a Role cannot reach this, and that is a consequence rather than an omission.** A Role
whose deletion would cost the deployment its last administrator is by definition a Role a
Merchant holds, and the next section refuses that first, by name.

**#173's ticket says "cannot be stripped of it or deleted", and only the first half is
implemented, because the second has nothing to refuse yet.** There is no
`DELETE /admin/merchants/{id}` on this surface and no route that reassigns a Merchant's Role —
`POST /admin/merchants` is the whole of what writes `core_merchant` — so the only reachable way
to lose the last administrator is the one above. **Whoever adds either route inherits this
invariant**, and inherits it in the harder form: the check will have to count the *Merchants*
holding the Permission rather than the Roles carrying it, and it will have to take the same lock
before its read, because "delete this Merchant" and "narrow this Role" can race each other just
as two narrowings can. Adding one of those routes without extending the guard would reopen
exactly the lockout this record closes, and no test here would notice.

### The guard is a lock taken before the read, and ADR-0018's usual answer does not reach it

[ADR-0018](./0018-one-reservation-model-implemented-without-holds.md) requires a claim on
something scarce to be **one conditional statement** — `update … where <the condition>` — never a
read followed by a write, because Postgres takes the row lock before evaluating the condition
and the loser of a race re-evaluates against what the winner left. That works for Inventory
because **the condition is about the row being written**.

This condition is not. It asks whether any *other* Merchant, on any *other* Role, still holds
`merchant:write` — and a subquery reads those rows without locking them. Two requests each
stripping a different last administrator would each find the other's Role, both pass, and both
commit: write skew, which no amount of care inside one statement removes.

So `updateRole` takes `pg_advisory_xact_lock` on a fixed key **before** it reads, and holds it to
commit — the shape `createFirstMerchant` already uses to make the first Merchant happen at most
once. Two alternatives were weighed. `SELECT … FOR UPDATE` over every Role carrying the
Permission is more targeted and locks a set the caller has to enumerate correctly every time
somebody edits this function; `SERIALIZABLE` moves the failure to a serialisation error the
handler would have to translate back into this refusal. The advisory lock is one line, one place,
and serialises only the operation that can break the invariant.

`packages/core/src/auth/the-last-administrator.test.ts` is the guardrail, and it was **watched
failing** with that line removed: all six requests answered 200, none was refused, and the
deployment was left with no administrator at all and no error anywhere.

## A Role Merchants hold is refused rather than cascaded or reassigned

**Decided: `DELETE /admin/roles/{id}` answers 422 `role-in-use` while any Merchant holds it.**

[ADR-0059](./0059-catalog-deletion-refuses-rather-than-cascading-or-releasing.md) took the same
decision about a Variant with stock claimed against it, and the reasoning transfers whole. There
were three candidates:

- **Cascade** — delete the Merchants with the Role. Deleting people to tidy up a label, and the
  only irreversible one of the three.
- **Reassign** — move them to some other Role. Core would be choosing what a colleague becomes,
  and every choice is wrong: a narrower Role takes access away silently, and `owner` grants
  everything to somebody nobody promoted.
- **Refuse** — and say who holds it. The Merchants stay exactly as they were, and the repair is
  one a Merchant can carry out themselves.

The schema had already taken this position — `core_merchant.role_id` is `on delete restrict`,
with a comment saying a Role deleted out from under its holders would leave them authenticated
holding nothing — so what #173 added is the refusal being *legible* rather than a foreign-key
violation surfacing as a 500.

**It is read off Postgres rather than asked for first.** A `select` for Merchants followed by a
`delete` would let a concurrent `POST /admin/merchants` put one on the Role in between, and the
key would then refuse what the read had already promised was safe. The delete is one statement
and the violation is caught and named — the same shape `createMerchant` uses for a taken email.

## One Permission gates all six, and it is `merchant:write`

**Decided: every route here — the reads included — sits behind `merchant:write`, and #173 adds
no Permission.**

This departs from the read/write split the surface otherwise draws (`store:read` is not
`store:write`; `catalog:` and `api-key:` likewise), so it needs an argument rather than a
precedent.

**`merchant:write` already confers everything a Role could confer.** A Merchant who may add a
colleague may add one against `owner`, sign in as them, and hold every Permission the deployment
has. So it is not "the power to create a row in `core_merchant`" — it is the power to administer
access, entire. Naming a `role:write` beside it would draw a boundary that does not exist, and
would leave a deployment believing it had separated two powers that are one.

The reads are the weaker half of that. There is a real Role that wants
`GET /admin/merchants` and not `POST /admin/merchants` — an auditor who may see who has access
without granting any — and `api-key:read` is the precedent for splitting exactly that out. What
decided it the other way is that nothing in this ticket needs the distinction, and that the two
mistakes are not equally expensive: a route gated too narrowly refuses somebody who should be
let in, which is visible the first time it happens, and one gated too widely lets somebody in
quietly. The narrow one is also the one this repository is set up to relax —
[ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md)'s licence is open
until the first publish, and adding a Permission is one edit and one migration, which AGENTS.md
already documents.

**This is the part of the record to revisit first**, and the trigger is concrete: the day a
deployment wants a Merchant who can see the team and not change it, or the day a Plugin brings
Permissions of its own, `merchant:read` is the shape of the answer. After the first publish it
costs a major.

## Consequences

- **Four `reason`s are promised from the day this ships** — `role-not-found`,
  `role-name-taken`, `role-in-use` and `last-administrator` — in `ROLE_REASONS`, bound to
  `auth/role.ts`'s own unions by the same mapped `satisfies` every other family uses, so
  renaming one turns `contract.ts` red.
- **`role-in-use` and `last-administrator` are 422 rather than 409**, on ADR-0065's distinction:
  a 409 says somebody got there first and invites a retry, and neither of these becomes possible
  by itself. What lifts each is a deliberate act somewhere else — Merchants moved off the Role,
  or another Role given `merchant:write` and a Merchant given that Role.
- **A Role edited under a live session takes effect on the next request.** `resolveSession`
  joins `core_role` on every authenticated request rather than copying the permission set into
  the session, so access follows the job without anybody signing out — which is what the Admin's
  permission affordances (#178) assume, and `role.test.ts` now asserts.
- **No migration, and no schema change.** `core_role` already had every column these routes
  need, its `updated_at` trigger among them (ADR-0037) — which is why #173 is the rare surface
  ticket that adds no migration at all.
- **Roles are testable through the public API**, so no test in this repository builds a narrower
  Role with SQL any more. The four that did now call `POST /admin/roles`, which is what makes
  them tests of something a Merchant can actually do.
- **A Role's name may be changed, `owner`'s included.** Merchants hold a Role by identifier, so a
  rename moves every holder with it; what it breaks is a `POST /admin/merchants` that names the
  old one, and `OWNER_ROLE` is the default that request falls back to. Nothing here protects the
  name, because the lockout this record is about is measured in Permissions held, not in a word.
