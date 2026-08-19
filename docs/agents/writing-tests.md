# Writing tests

The seams kobai tests through, the harness each one reaches for, and the arrangement helpers `@kobai/core/testing` promises. **Read this before writing a test anywhere in this repository** — the guidance is about the seam, not about the directory, so it applies in `packages/*/src`, in `reference/src` and in `tests/` alike.

Part of [`AGENTS.md`](../../AGENTS.md), which is the source of truth and says when to read this.
## Writing tests

The dominant seam is the **public HTTP API, dispatched in-process against a real Postgres**.
Reach for `createTestKobai` from `@kobai/core/testing`: it creates a throwaway database, runs
every migration set into it, and hands back an object you dispatch requests at.

```ts
import { createTestKobai, signInTestMerchant } from "@kobai/core/testing";

await using kobai = await createTestKobai(); // `using` drops the database on the way out
const merchant = await signInTestMerchant(kobai);
const response = await kobai.request("/admin/store", { headers: merchant.headers });
```

The **admin surface is closed by default, with no unauthenticated write path anywhere under
it** (ADR-0041): `/admin/*` sits behind a Merchant session, each route names the one
permission its Role must hold, and the *first* Merchant is the one thing a deployment is given
rather than asked for — seeded at boot from `initialMerchant`, because on a deployment holding
none there is nobody who could hold `merchant:write`. So `signInTestMerchant` **seeds** that
Merchant, exactly as a boot does (`seedTestMerchant` is the same call without the sign-in),
and then signs them in through the public API. There is no HTTP way to create the first one
and a test that reaches for `POST /admin/merchants` anonymously is asserting against a 401. A
test about *not* holding a permission should create a narrower Role itself — that is the
subject, and a helper would hide it; **that Role goes through `POST /admin/roles`** since #173,
never through `insert into core_role`, and that second Merchant goes through
`POST /admin/merchants` with the seeded one's session, which is the only way there is, and
`sessionOf(response)` reads the session cookie off their sign-in response the way a browser
would.

**`auth.test.ts` sweeps the whole admin surface** — every operation the generated description
carries, called with no cookie, asserted 401 — so a route registered on the wrong half of
`admin.ts` fails on the day it is written. Adding an admin route means moving the count that
sweep asserts, and that is the moment to check which half it landed on.

A session **is a cookie, not a bearer token** (ADR-0032). `merchant.headers` is
`{ cookie: "kobai_session=…" }` and the token is in no response body, so a test that reaches
for an `Authorization` header to open `/admin` is reaching for the transport that was removed.
The one exception is a test whose *subject* is that removal — `auth.test.ts` presents the
token as a bearer and asserts it is refused, because a gate that quietly kept accepting both
would pass every other test in the file.

The **store surface is closed by default too, behind a different gate**: `/store/*` sits
behind a bearer API key rather than a Merchant session (ADR-0020), so neither credential is
worth anything on the other surface — nor does either even arrive the same way.
`createTestApiKey` mints one through the public API, which means a Merchant has to be signed
in first:

```ts
const merchant = await signInTestMerchant(kobai);
const key = await createTestApiKey(kobai, merchant); // secret unless you ask otherwise
const price = await kobai.request("/store/variants/…/price", { headers: key.headers });
```

A test whose subject is the *kind* of key should ask for the kind it means
(`{ kind: "publishable" }`) and say why, rather than leaning on the default.

**The harness wires a Payment Provider, because Core ships none and almost no test is about
one** (ADR-0053). `createTestKobai` passes `testPaymentProvider` — takes every payment, gives
any of it back, remembers nothing — the same courtesy `silentLogger` is, and for the same
reason: without it every test that places an Order would be a test about not having a
provider. It is not a provider a deployment could use, and it is not what a test *about*
payment should reach for:

```ts
await using kobai = await createTestKobai({ payments: { provider: mine } }); // one of your own
await using none = await createTestKobai({ payments: {} });                  // a deployment with none
```

**Ask the provider what it is holding; never count that a callback was reached.** A refund is
the one thing `place-order` can undo, so a test about unwinding writes a provider that keeps
books and asserts on them — `packages/core/src/payment/payment.test.ts` is the shape, and the
distinction is the same one ADR-0036 draws for a compensation that throws: "the code ran" and
"the Shopper got their money back" are two facts, and a counter only ever knows the first.

**Almost every test needs something to sell before it can assert anything, and that
arrangement is one line.** `seedTestCatalog` creates a Product, the Variant that makes it
sellable and a Price on that Variant — through the public API, like everything else here, so
a Plugin's test is doing exactly what a Plugin can do — and signs a Merchant in and mints a
secret key on the way, because the catalog is reached through one gate or the other:

```ts
const catalog = await seedTestCatalog(kobai); // "A poster", one POSTER-A2, one Price of 1250

const price = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
  headers: catalog.apiKey.headers,
});
const product = await kobai.request(`/admin/products/${catalog.productId}`, {
  headers: catalog.merchant.headers,
});
```

**Amounts are integer minor units** — 1250 is USD 12.50 — and a Price's currency is the
Store's default, which since #5 is the only currency a Price may carry. So the helper takes
no currency at all: the correct thing is the only thing.

**Nothing it seeds is counted**, and there is deliberately no option that counts it. A Variant
with no Inventory row sells freely and holds no Reservation (ADR-0018), which is what every test
that is not about stock wants; a test that *is* about stock says so with
`PUT /admin/variants/{id}/inventory`, in the open, the way `reservation/reservation.test.ts`
does.

It hides the arrangement a test does not care about and **never the thing the test is
about**, which is the same line `signInTestMerchant` draws. A test asserting on the OpenAPI
description takes the one-liner; a test asserting on price *selection* names the Prices it
means, and they stay visible in the test rather than becoming a default it inherited:

```ts
await seedTestCatalog(kobai, { prices: [1250, 900] });   // two Prices on one Variant
await seedTestCatalog(kobai, { prices: [] });            // a Variant with no Price at all
await seedTestCatalog(kobai, {                           // several Variants; an unnamed one
  variants: [{ prices: [1250] }, { sku: "MUG", prices: [] }],  // takes POSTER-A2, A3, …
});
await seedTestCatalog(kobai, { merchant });              // one already signed in (ADR-0041)
```

`prices` is the one-Variant shorthand for `variants` and naming both is a type error. Ask for
a Variant by SKU — `catalog.variant("MUG").id` — never by position: a Product reports its
Variants in **SKU order**, not in the order they were asked for. `catalog.variantId` is the
first one asked for, for the common case that has only one.

**Everything it seeds is `physical`, and a test that cares says so.** A Variant's Fulfilment
Strategy decides whether it consumes stock at all (ADR-0014), so a test about that names the one
it means — and a name this deployment has not wired is refused by the route, exactly as it would
be for a Merchant:

```ts
await seedTestCatalog(kobai, { variants: [{ sku: "PDF", fulfilmentStrategy: "digital" }] });
await using kobai = await createTestKobai({          // a Plugin's, wired (ADR-0017)
  fulfilment: { strategies: { "made-to-order": madeToOrder } },
});
```

**A Cart is the arrangement every ticket in the commerce spine starts from**, and
`seedTestCart` is the one line that produces one. It seeds a catalog if it is not given one,
starts a Cart over the store surface, and puts a line on it — so the common case is one call
and the identifier is what comes back:

```ts
const cart = await seedTestCart(kobai);          // one POSTER-A2, quantity 1, for a guest

const response = await kobai.request(`/store/carts/${cart.id}`, {
  headers: cart.apiKey.headers,
});
```

**The Cart's `id` is the whole of the authority to act on it** — there is no Shopper session
to hang one off and there must never be one (ADR-0020) — so a test holds it exactly as a
storefront does. The Cart it seeds is a **guest's**, because a guest is what Core assumes
everywhere; a test whose subject is attribution asks for a Shopper, which needs a secret key:

```ts
await seedTestCart(kobai, { quantity: 3 });               // three of the one Variant
await seedTestCart(kobai, { lines: [] });                 // an empty Cart
await seedTestCart(kobai, { catalog });                   // one already seeded (ADR-0041)
await seedTestCart(kobai, {                               // several Variants, named by SKU
  catalog,
  lines: [{ sku: "POSTER-A2" }, { sku: "MUG", quantity: 2 }],
});
await seedTestCart(kobai, { shopper: { email: "…" } });   // not a guest's (ADR-0020)
await seedTestCart(kobai, { catalog, apiKey: publishable }); // a browser's key builds a Cart
```

`quantity` is the one-line shorthand for `lines` and naming both is a type error, exactly as
`prices` and `variants` are. Ask for a line by SKU — `cart.lineItem("MUG").id` — never by
position. `cart.catalog` is what the Cart was built from, so `cart.catalog.merchant` is the
session for anything the test then does on the admin surface. **Passing `catalog` is how a
test that has already signed in gets a Cart at all**, since a deployment has only ever one
first Merchant.

Two things this helper deliberately does not do. It never expires a Cart: a lifetime is
measured in days, so time is passed by winding `expires_at` back on the row, the way the
session tests do it — see the foot of `packages/core/src/cart/cart.test.ts`. And it is not
what a test about *building* a Cart should reach for; `cart.test.ts` calls the routes by hand
for the same reason a test about price selection names its own Prices.

**Everything downstream of Capture starts from a placed Order**, and `seedTestOrder` is the
one line that produces one. It seeds a Cart if it is not given one — which seeds a catalog if
*that* is not given one — and places it over the store surface, so the common case is one call
and the Order's identifier is what comes back:

```ts
const order = await seedTestOrder(kobai);      // one POSTER-A2 at 1250, placed by a guest

const response = await kobai.request(`/admin/orders/${order.id}`, {
  headers: order.catalog.merchant.headers,
});
```

**It places with a secret key, always.** The Cart's own if that key can place, so a test that
named one is placing with the key it named; the catalog's when it cannot, because placing is
where money moves and a publishable key is refused there (`403 secret-key-required`, ADR-0055)
— and that is exactly the key a browser holds. So the last line below is the storefront
pattern itself: the browser builds the Cart and the server places it. `order.apiKey` is
whichever key placed it, and reading the Order back needs that one too.

```ts
await seedTestOrder(kobai, { quantity: 2 });                  // two of the one Variant
await seedTestOrder(kobai, { catalog });                      // a catalog already seeded
await seedTestOrder(kobai, { cart });                         // a Cart already built
await seedTestOrder(kobai, {                                  // several Variants, by SKU
  catalog,
  lines: [{ sku: "POSTER-A2" }, { sku: "MUG", quantity: 2 }],
});
await seedTestOrder(kobai, { catalog, apiKey: publishable }); // a browser builds the Cart
```

Everything beside `cart` is `seedTestCart`'s own option, passed through untouched, so a Cart
this helper builds is the Cart that helper would have built — and naming `cart` alongside any
of them is a type error, exactly as `quantity` and `lines` are. Ask for a line by SKU —
`order.lineItem("MUG").total` — never by position: an Order reports its lines in **SKU
order**, not in the order they were selected. `order.cart` is what it was placed from and
`order.catalog` is what that was built from, so `order.catalog.merchant` is the session for
anything the test then does on `/admin` — the same reach `cart.catalog.merchant` is, because
an Order is read by a Merchant as a matter of course.

Three things this helper deliberately does not do. **It configures no Payment Provider** — one
belongs to the deployment rather than to a Cart (ADR-0053), `createTestKobai` already wires
`testPaymentProvider` unless the test said otherwise, and by the time a helper runs that seam
has closed; on a deployment that has none it fails naming the `no-payment-provider` refusal,
which is the honest answer. **It sends no `Idempotency-Key`**, because a test about a retry is
a test about the key and names its own. And **it is not what a test whose subject is the
placement itself should reach for**: every refusal `POST /store/orders` makes is a status this
helper never returns, and the 201 body carries an account of the Workflow run that it
deliberately drops. So `place-order.test.ts`, `idempotency.test.ts`, `payment.test.ts`, the
reference Project's `kobai.config.test.ts`, and every test in `order.test.ts` that asserts on
what placing *answered* call that route by hand — for the same reason `cart.test.ts` builds
its Carts by hand.

**The harness is promised surface** (ADR-0047): everything `@kobai/core/testing` exports is
covered by ADR-0019's semver commitment, because it ships for the Plugin author who needs the
same seam Core tests through — while the five Extension Points of ADR-0003 stay five, since
nothing attaches to a test harness at runtime. So a helper added here is designed as public
API and documented in this section, and what a helper does *internally* — which requests it
makes, in what order — is promised to nobody. `seedTestCatalog`'s, `seedTestCart`'s and
`seedTestOrder`'s own contracts, including every case above, are asserted in
`packages/core/src/testing/catalog.test.ts`, `packages/core/src/testing/cart.test.ts` and
`packages/core/src/testing/order.test.ts` against the running application rather than against
the object each returns.

**Contention has a shape, and it stays in the HTTP seam.** ADR-0018 requires check-and-consume to
be a row lock or a unique constraint and **never a `select` followed by an `update`** — and
nothing sequential can tell those apart, because the forbidden shape passes every assertion in
`reservation.test.ts`. So the test *dispatches at once*:
`packages/core/src/reservation/the-last-unit.test.ts` puts one unit on the shelf, builds a Cart
per Shopper, and fires `POST /store/orders` at all of them inside one `Promise.all`.
`packages/core/src/reservation/the-variant-that-vanished.test.ts` is the second, and the pair is
what makes this a technique rather than a special case: it dispatches six deletes and six counts
at six Variants together and holds every count to one of the two answers that are true (#145).
Four things about how they are written carry to the next one:

- **Assert on what the losers were told, and on the books, not only on the winner.** One 201, and
  every other request refused with the *reason that is true* rather than failing some other way;
  the shelf left at **zero rather than at minus something**; and **one card charged, none
  refunded**. That last one is what tells atomicity from a backstop — a hold that let everybody
  through is still caught inside Capture and the shelf still ends at zero, but by then every
  loser has been charged and refunded for a purchase that never happened.
- **A Cart each, not one Cart many times.** A Cart becomes exactly one Order, so the second shape
  is a test about *that* uniqueness rather than about scarcity, and it would pass either way.
- **How many is a named constant with its reason beside it.** Big enough that more than one
  request is inside the gap on any scheduling, small enough to stay well inside the connection
  pool — queueing behind connections serialises the very thing the test exists to overlap.
- **Each was watched failing before it was made to pass** — the first against a deliberately
  non-atomic hold, the second against the two loose statements it was written about — and what
  each run did is written down in its own file. **Write the next such test the same way round**;
  a race nobody has seen lost is not yet known to be losable. **That recorded run is the whole of
  the proof, because once the fix is in the test can no longer show the window was reached** — a
  request that landed in the gap and one that arrived after the other transaction committed now
  answer identically, which is what the fix is for, so a green run cannot tell a contended race
  from an arrangement that quietly stopped overlapping. `the-variant-that-vanished.test.ts` says
  that in as many words and it is true of both. Changing how the requests are dispatched
  therefore obliges you to watch it fail again rather than to trust that it still would.

The **migration seam** covers what HTTP cannot — that sets apply independently, into
separate tracking tables, in any order. Take a harness with `{ migrate: false }` and drive
the runner yourself:

```ts
await using kobai = await createTestKobai({ migrate: false });
await runMigrations(kobai.db, [pluginSet, coreMigrationSet]); // order is yours to choose
```

It also covers the thing every other seam here cannot: a migration meeting **rows that are
already there**. A test database is created seconds before it is migrated, so a migration
that cannot survive existing data passes everywhere in this repository and fails at the
first Project with traffic. `migrationSetUpTo` truncates a set at a named migration, which
puts the database where a real deployment is on the day the next one reaches it — apply what
had shipped, write rows through it, then apply the rest:

```ts
await using before = await migrationSetUpTo(pluginSet, "0000_creates_the_table");
await runMigrations(kobai.db, [before]);
await kobai.database.query("insert into … values (…)");

const upgrade = await runMigrations(kobai.db, [pluginSet]); // onto rows, as it will be
```

Seed **before** asserting, and say the rows are there — a widening applies cleanly to a
table that stayed empty, so the arrangement is the whole test. See ADR-0038 and
`packages/plugin-price-log/src/migrations.test.ts`.

**Never write down how many migrations a set has** (ADR-0049). Five assertions did, across
three packages, and every ticket that added a migration edited all of them — which is how a
Core migration ended up editing a Plugin's test. Ask the journal instead, and pair it with
the question the count cannot answer:

```ts
const declared = await declaredMigrations(coreMigrationSet); // by tag, in journal order
expect(declared.length).toBeGreaterThan(0);                  // two empty lists are equal
await expect(appliedMigrations(kobai.database, coreMigrationSet)).resolves.toEqual(declared);
```

**The count and the pairing are not the same assertion, and both are wanted.** A count taken
from the journal and compared against rows written from that same journal agrees with itself;
it still catches a row the set does not account for, which is Drizzle having applied
something twice (ADR-0030). `appliedMigrations` asks the database *which* of a set's
migrations it holds, matching each row by the sha256 Drizzle stores of the `.sql` — so a
migration that never ran is named rather than subtracted, and the failure reads as a missing
tag instead of `expected 9 to be 10`. A set this database has never seen is `[]`, not an
error.

What a derived count gives up is a migration deleted from the journal along with its `.sql`:
both sides shrink and nothing here disagrees. That is caught by the test that owns the
migration's **effect** — dropping `0009_updated_at_triggers` reddens `updated-at.test.ts`,
dropping a seed migration reddens `auth.test.ts` — which is also the only place that can say
what actually went missing. So **a migration whose effect no test asserts is the real gap**,
and it was never a number's job to close it.
`packages/core/src/testing/migrations.test.ts` watches the pairing fail against a database
that is deliberately one migration short, because an assertion nobody has seen fail is not
yet known to be able to.

**Never write down which migration *sets* exist either** (#129). That was the same tax one
level up: a dozen sites across six files spelled the same list four ways — a package path, a
set name, a tracking-table name, a manifest key — and adding a Plugin edited most of them.
The two answers live beside each other and are deliberately **two modules**, because they do
not have the same reach: `tests/support/wired-migration-sets.ts` reads
`reference/kobai.config.ts` with Core's set in front, exactly as `createKobai` composes it,
and `tests/support/migration-sets.ts` asks pnpm and the journals on disk and has never heard
of that config. So an **in-repo** test derives its expectation from the config; a **container
or generated-Project** test — which asserts from outside a booted image, and must not reach
into this workspace's config — goes structural through `migrationReportFindings()` instead:
no set applied nothing, and as many sets applied as the workspace ships packages that own
one. Keeping the config out of that module's import graph is what makes the boundary
something other than a comment, so **do not merge the two files back together.**

Everything derived that way inherits ADR-0049's trap, and the answer is the same shape: a set
dropped from `reference/kobai.config.ts` shrinks the expectation along with the thing it
checks. `tests/every-migration-set-is-wired.test.ts` is what cannot agree with itself — it
compares that config against the packages on disk, in both directions, and names any package
whose tables no deployment in this repository would ever create — and it has been watched
failing, both against a workspace written to offend and against the real config with a
Plugin's set taken out of it.

**Adding a Plugin to the reference Project should need no test edit, with one deliberate
exception.** `reference/src/kobai.config.test.ts` names the sets that config wires, and that
enumeration is that test's whole subject — it is the Project's test of its own config file,
the way `adaptations.ts`'s length is asserted. Extending it is the work. Anywhere else, a
list of set names is the tax coming back: check whether the enumeration is the test's actual
subject before adding to it.

**One migration test is not in-process, and that is the point.**
`tests/the-cli-and-the-migrator-agree.test.ts` shells out to the real `drizzle-kit migrate`
and then runs the programmatic migrator against the same database — CLI first, then the other
way round, with every set the reference Project wires — and asserts that each recognises the
other's work and applies nothing. ADR-0030 rests entirely on that agreement, and the two
migrators are two *implementations* with different defaults, so nothing smaller than running
both can see it.
Until #46 it was checked by hand whenever somebody remembered, which is what a drizzle bump
now arriving automatically made untenable.

**It runs in `devbox run ci` like everything else, deliberately** (ADR-0044). It adds a few
seconds to a gate that already builds images and stands up a registry, and the gate
already provides both things it needs — Postgres, and the `pnpm -r build` whose `dist` a
Plugin's `drizzle.config.ts` resolves `@kobai/core/migrations` through. A guardrail behind an
opt-in step is not a faster guardrail, it is an optional one. The one visible consequence is
that a bare `vitest` with no build ahead of it fails on this file; the failure says so and
names `devbox run build`.

The **schema seam** covers the rest of what HTTP cannot: ADR-0004's rules are properties of
the schema, not behaviours. Ask Postgres what it is holding, through `inspectSchema` from
`@kobai/core/testing` — never by hand-rolling another `information_schema` query, because
there should be one of those:

```ts
const schema = inspectSchema(kobai.database);

await expect(schema.tablesOwnedBy("price_log")).resolves.toEqual(["price_log_entry"]);
await expect(schema.foreignKeysCrossingInto("core")).resolves.toEqual([]);
await expect(schema.columnsOwnedBy("core")).resolves.toEqual(stockCoreColumns);
```

It also reads `migrationTracking()`, `columnsOf()`, `indexedColumnsOf()` and `triggersOf()`
— that last one because Core advances `updated_at` in the database rather than in TypeScript
(ADR-0037), so "does this table have the trigger" is a question about Postgres. It scans
every non-system schema rather than only `public` — the prototype's inspector reported "no
tracking tables" for exactly that reason while they sat in `drizzle` the whole time.

`foreignKeysTargeting(table)` asks the foreign-key question of **one table instead of one
package**, and it is the stronger of the two: `foreignKeysCrossingInto` excuses a package's
references to itself, which is right for ADR-0004 and wrong for the Store. ADR-0005 says the
Store is referenced by *nothing* — a `core_` table growing a `store_id` smuggles in the same
scoping key a Plugin's would, and the prefix sweep would read it as Core's own business. So
`store.test.ts` asks this one, and pairs it with a test that creates such a table and watches
the sweep name it, because an emptiness assertion nobody has ever seen fail is not yet known
to be able to. **Pass the qualified ref `tables()` hands back**, not a bare name: a bare name
resolves to `public`, and a sweep aimed at the wrong schema finds nothing and reports that
the rule holds.

The **Workflow seam** is the one place a test may reach past HTTP into a module, and it is
allowed because a declared Workflow *is* a public interface: it is one of ADR-0003's five
Extension Points, imported and read by a Project. `describe()` naming its Steps in order, and
a replacement being rejected by the compiler, are promises no response body can carry — so
`packages/core/src/workflow/workflow.test.ts` asserts them directly, including the type-level
ones, which the `typecheck` step of the gate is what actually runs. **Replacing a Step**
splits across both: that overriding rebuilds the declaration rather than aliasing it, that it
leaves the Workflow it was given alone, and that it refuses a slot the Workflow never declared
are promises about the object, so they stay there. What an override *does* is tested through
HTTP like everything else, by booting with one:

```ts
await using kobai = await createTestKobai({
  workflows: { "resolve-price": { steps: { "select-price": myStep } } },
});
```

That is the same `kobai.config.ts` shape a Developer writes, so a test of the override
mechanism is a test of the thing they actually do. **Every key of that file the harness
accepts works the same way**, `session: { idleWindowMs }` included (ADR-0050) — and a value
Core will not serve rejects the `createTestKobai` promise rather than booting, because
`createKobai` refuses it. Time is passed by winding the row back rather than by waiting; the
helpers at the foot of `auth.test.ts` are the only honest way to test a window measured in
minutes.

**Inserting a Step** sits beside `steps` rather than inside it, so replacement and
observation are distinguishable at a glance, and a list because observing composes:

```ts
workflows: {
  "resolve-price": {
    steps:  { "select-price": myStep },        // owns the slot
    after:  { "select-price": [watchIt] },     // watches it; `before` likewise
  },
}
```

An inserted Step takes and gives the **same** type — what the slot is given, before it; what
the slot produced, after it — so it cannot alter the output contract. That is enforced by the
same compiler check that rejects a bad replacement, and the `@ts-expect-error` assertions
pinning it live beside the ones for replacement. **Compensation** is a third argument to
`defineStep`; the runner unwinds the Steps that completed in reverse when a later one fails,
handing each one the very value its `run` was given. That unwinding *order*, and that the
value is the same one, are promises about the declaration and are asserted in
`workflow.test.ts` like the rest of the Workflow seam. So is what happens when a compensation
itself throws (ADR-0036): **unwinding is exhaustive** — every completed Step's compensation is
attempted, in reverse, and one that throws neither stops the ones before it nor replaces what
stopped the run. The refusal still answers with its own `reason`, a Step's bug still travels
as itself, and the compensations that threw are reported beside the outcome — as
`uncompensated` on a refused `WorkflowRun`, or as the `UnwindFailure` a travelling bug becomes
the `cause` of. Whether a compensation actually undid anything is not — ask the database, as
`packages/plugin-price-log/src/record-price-resolution.test.ts` does, and never settle for a
counter that says the callback was reached.

The **packaging seam** covers what none of those can, because it is not about a running
database at all: that the `migrations/` directory each package resolves relative to its
*built* output survives being packed, and so actually reaches a Project's `node_modules`.
`tests/packaged-migrations.test.ts` packs every workspace package that ships a
`migrations/` directory or names one in `files`, and reads the tarball back. The packages
are discovered rather than listed, so the next Plugin is covered without an edit.

The **browser seam** is the Admin's, and it is the only one that opens a browser.
`tests/the-admin-in-a-browser.test.ts` drives Chromium against a really-booted reference
Project; `tests/support/admin-browser.ts` is the harness and its header says how to add a
case. It asserts the **frame's** promises — deep-linking, refresh, back and forward, session
expiry and return, a refusal rendering where it was attempted, list, loading and empty states,
and what a Role is offered and refused (#178) — with `axe-core` on every screen and explicit
keyboard assertions beside it. It
asserts no screen behaviour: **a case a request could have asked belongs in the HTTP seam.**
[The Admin](the-admin.md) has the rest of it.

The **image seam** is the last one, and its rule is: **ask the built image, never the
Dockerfile.** Both Dockerfiles ran `pnpm install --prod` in their runtime stage, which looks
exactly like the thing that drops devDependencies and is not — run over an existing
`node_modules` it rewrites the symlink farm and leaves `node_modules/.pnpm`, every
devDependency's bytes, where it was. It relinks; it does not prune, so `drizzle-kit`,
`vitest`, `biome`, `typescript`, React, Vite and Tailwind all shipped, and no reading of the
file said so (#12). Pruning therefore happens in the **build** stage, before anything is
copied out of it: a `rm -rf` after a `COPY --from` hides the bytes in a lower layer and the
image is the same size. `tests/support/container.ts` builds an image, reads inside it and
boots it; `tests/the-runtime-image.test.ts` does that to the repository's, and
`tests/a-project-boots-from-its-own-compose-file.test.ts` generates a Project and runs
`docker compose up --build` on the compose file and Dockerfile a Developer receives.
Inspecting is not enough on its own — a prune that removed something the runtime needs looks
identical to one that worked until the container is made to serve a request.

**A credential is a build secret, never a file.** A Project's `.npmrc` holds an auth token
when kobai comes from a private mirror, and a token that arrives through `COPY` is in an
image layer forever, whatever a later `rm` says. So `.dockerignore` refuses the file and the
Dockerfile mounts it — `RUN --mount=type=secret,id=npmrc,target=/app/.npmrc` — for the length
of the install and no longer. Both halves, because either alone is a trap: the ignore line
without the mount breaks every private-registry build, and the mount without it leaves the
accident possible. The Project's image test greps the built image for the token rather than
reading the Dockerfile, which is the only check that can see this.

Real Postgres rather than a fake, because under
[ADR-0004](../adr/0004-plugins-own-their-tables-core-tables-are-closed.md),
[ADR-0011](../adr/0011-postgres-and-drizzle.md) and ADR-0030 the schema and its migrations
*are* part of the product — a fake skips the thing most likely to break. Assert on response
bodies, status codes and database state; never on internal call sequences or module
structure, which Core reserves the right to change
([ADR-0019](../adr/0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md)).

