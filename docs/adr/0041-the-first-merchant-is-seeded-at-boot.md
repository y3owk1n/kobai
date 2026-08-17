# The first Merchant is seeded at boot, and Core has no unauthenticated write path

A deployment's first Merchant is created at boot, from credentials the deployment was
configured with, in the same pass that applies the migrations. `POST /admin/merchants` is an
ordinary route behind `merchant:write` like every other admin route, and **nothing under
`/admin` can be written to without a session**.

Before this, that route answered an anonymous request while the deployment held no Merchant
(#4). It was race-safe — `pg_advisory_xact_lock`, emptiness re-checked inside the transaction
— and it was still wrong: **whoever reached a fresh deployment first owned the Store.** A
container is reachable the moment it is up, and the window between "up" and "the Merchant got
round to it" is not a window anyone controls. Access control that depends on winning a race
against the internet is not access control.

## What is decided

- **The first Merchant is a thing a deployment is *given*, not a thing it is *asked* for.**
  It arrives as configuration, beside the database URL, and is created after the migrations
  because the table has to exist first.
- **`POST /admin/merchants` stays**, gated by `merchant:write`. Spec #1 asks for Merchant
  creation and adding a colleague is a real need; what went away is the anonymous branch,
  its `OPTIONAL_MERCHANT_SESSION` security declaration, and the `already-claimed` conflict a
  caller could reach.
- **Core takes the credentials; it does not read the environment.** `createKobai` takes
  `initialMerchant`, and the reference Project fills it from
  `KOBAI_INITIAL_MERCHANT_EMAIL` and `KOBAI_INITIAL_MERCHANT_PASSWORD` — the same division
  as `databaseUrl`, which Core has never read for itself. A Project whose secrets live in a
  vault or a mounted file builds the same object from there, and a test passes one in
  without touching a global.
- **Seeding is reported in four outcomes, not two**: `seeded`, `already-present`,
  `not-configured`, `not-usable`. That is the shape `/health` already uses for migrations,
  and for the same reason — a deployment that was never configured, one configured wrongly,
  one just given its Merchant and one that already had one are four different things for an
  operator to do next.
- **Nothing about seeding stops a boot.** A failed migration must exit, because serving
  against a half-migrated schema is worse than not serving. An unconfigured Merchant is not
  that: it is a working deployment nobody can administer yet. A process that exited over it
  would look, to whatever supervises the container, exactly like the migration failure that
  must exit — and would take `/health`, the endpoint that exists to tell those apart, down
  with it.

## Idempotence, in two places

Booting twice must not fail and must not create a second Merchant, and a deployment may boot
twice at the same time.

1. **Before the transaction**: if any Merchant exists, seeding stops there and reports
   `already-present`. This is the ordinary restart, and it answers without taking a lock —
   and *before* looking at the configuration at all, so a deployment that has been running
   for a year does not start failing its boot because somebody rotated a variable that has
   had no job since the first one.
2. **Inside the transaction**: creating the first Merchant takes `pg_advisory_xact_lock` and
   re-checks emptiness, which is the only thing that can decide between two processes booting
   against one database in the same second. The loser is reported `already-present` too,
   because from a boot's point of view that is what happened.

The consequence worth stating: **a deployment that already has a Merchant is left exactly as
it was found, whatever it was configured with.** Rotating the variables does not create a
second account and does not change the first one's password. The variables can be removed
after the first boot.

## What the boot log prints, and what it does not

The password arrives through an environment, so it already exists in a compose file, a
secrets manager or a shell history. The log is the copy that would fan out to every
aggregator a deployment ships to, so:

- **The password is never printed, in any outcome.** Not on success, not in a refusal, not
  in a detail string.
- **The configured email is not printed when the configuration could not be used.** An
  operator who swapped the two variables would otherwise have their password written to the
  log by the very line reporting the swap. Once a Merchant exists, its address *is* printed —
  by then it is that Merchant's address rather than a guess about what a variable held, and
  knowing which account was created is what an operator signs in with.
- **An unconfigured deployment says so on every boot, at error level**, naming the two
  variables to set. It is two lines rather than one, and deliberately: Core reports the fact
  it observed, and the Project names the variables, because Core does not read them.

## Changing that password is a later ticket

There is no way to change a Merchant's password today — no route, no permission, no column —
so "must change on first sign-in" is not a flag that can be added here. It needs a route, a
permission, a widening of `core_merchant` under ADR-0038's three-migration shape, and a screen
in the Admin. **This is stated rather than left unsaid: the seeded password is as durable as
whatever set it, until that ticket lands.** Until then the mitigations are the ones above —
it is never printed, it is stored only as an argon2id digest, and the variables can be
removed from the environment once the first boot has used them.

## What this costs

- **A deployment can be started with no way in.** That is deliberate and is the point of the
  four outcomes: it says so at error on every boot, and the Admin's sign-in screen says where
  the first Merchant comes from. The alternative — refusing to boot — was rejected above.
- **Every deployment mechanism has to carry the two variables** to be usable, the way it
  already carries `DATABASE_URL`. **Compose forwards no variable a service does not name**, so
  both `app` services list them — as bare names in a list, not `KOBAI_…: ${KOBAI_…}` in a map,
  and the difference is the whole point of writing it down. A bare name is forwarded when it
  is set, from `.env` or from the shell alike, and **not set at all** when it is not; the
  interpolated map form sets it to an empty string instead, and warns about it on every
  `docker compose` that parses the file, `devbox run db` included. An empty string is a value
  Core would have to interpret. An absent variable is the answer it already has a name for.
  YAML allows no mixing, so the block is a list throughout.
- **The Admin lost its "claim this deployment" button.** It was the reason `create-kobai`
  could promise a Developer that `docker compose up` alone was enough to reach the Admin; that
  promise now rests on the two variables being set before the first boot, which is what
  `.env.example` and the sign-in screen say.
- **A Project that never calls `seedInitialMerchant()` is never seeded**, and nothing tells it
  so — the call sits beside `migrate()` in the Project's entrypoint rather than inside Core,
  because a Project owns its boot (ADR-0001, ADR-0031). It costs nothing on an upgrade: a
  Project old enough not to have the line already has a Merchant, created through the route
  this record closed, and seeding would have reported `already-present` anyway. A Project
  generated after this gets the line from the template.

## Alternatives rejected

- **Keep the anonymous branch and bind it to a first-run token.** A second secret to
  distribute, and it would still be a write path a stranger can reach.
- **Seed from a migration.** Migrations are checked into the repository, so the credential
  would be too — and a migration cannot be told about a deployment.
- **Have Core read `process.env` itself.** It would make the credential unreachable for any
  Project that keeps its secrets elsewhere, and would put a global read in a library whose
  test seam is an in-process object.
