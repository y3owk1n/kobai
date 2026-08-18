# The five Extension Points, and what kobai promises about them

You own your Project; kobai Core is a dependency of it
([ADR-0001](./adr/0001-customisation-lives-in-a-project-not-a-fork.md)). That only stays
true if there is a surface Core promises not to break under you. This page is that promise
written down: **five Extension Points, what each is for, and — because it matters more
than the list does — which of them actually work today.**

Read the status column before you build on a row.

| # | Extension Point | What it is for | Status today |
|---|---|---|---|
| 1 | **Configuration** | One file where everything your Project has changed is declared | **Proven** — `reference/kobai.config.ts`, exercised on every commit |
| 2 | **Workflow Step override** | Replace one named Step of a declared process; watch one without owning it | **Proven** — a replaced Step changes what the API serves, under test |
| 3 | **Dependency substitution behind named interfaces** | Hand Core your implementation of something it named | **Proven** — three interfaces you can supply, two of them taking an implementation that is not Core's |
| 4 | **Events** | React to something happening, without being in the path of it | **Promised only** — nothing to attach to; no bus, no emitter, no subscriber |
| 5 | **Admin UI slots** | Put your own UI inside the Admin at a declared position | **Promised only** — no slot mechanism exists |

## Core's semver covers these five and nothing else

This is the unusual part of the promise and the part most likely to burn you, so it is
here in the second section rather than in a footnote.

**A Core minor release may freely change any internal you could technically reach**
([ADR-0019](./adr/0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md)).
Not "should not". *May.* Core reserves the right to move internal functions, rename them,
re-cut its modules, and reshape its database tables inside a minor version, and doing so is
not a breaking change, because none of those things were ever promised.

The two halves of that follow, and both are meant literally:

- If you reached into a Core internal and a minor release broke you, that is the trade you
  made. It should have been visible to you at the time — that is what this page is for.
- If you stayed inside the five and a minor release broke you, **that is a bug in kobai**.
  Report it. The promise is not aspirational and a break in it is not your problem to work
  around.

## What is explicitly not promised

Named, so their absence from the list above is legible rather than accidental
([ADR-0003](./adr/0003-the-extension-surface-and-what-we-promise.md)):

- **Internal function signatures.** Anything not exported from `@kobai/core`'s entry point,
  and plenty that is exported for a Project's benefit under a name that says so.
- **Module layout.** Which file a thing lives in, which directory that file is in, and
  whether the module exists at all next month. `@kobai/core`'s `exports` map is the boundary
  and it carries no wildcard, so a deep import into `@kobai/core/src/…` does not resolve at
  all rather than resolving onto something unpromised. Do not put it back with a bundler
  alias or a `paths` entry — that is the boundary working, not a packaging bug.
- **Core's database schema shape.** Table names, column names, indexes, and the shape of
  every one of them. Core's tables are closed to Plugins by decision
  ([ADR-0004](./adr/0004-plugins-own-their-tables-core-tables-are-closed.md)), and closed
  to your Project by consequence: querying them directly works and will keep working right
  up until a migration you did not write changes them. The stable way to reach Core's data
  is the API and the Workflow context, both of which are on the list.
- **Anything not reachable through the five.** The list is the definition, not a summary of
  one.

Two things Core does put in your hands and does *not* consider internals, because they are
untyped on purpose: the `metadata` JSON column on Core's principal entities, and the
Workflow's open context. Neither is a way to reach into Core — they are how you carry data
Core has never heard of *through* Core
([ADR-0013](./adr/0013-core-owns-no-lead-time-pricing-and-workflow-context-is-open.md)).

## Reaching outside is allowed. It costs you the upgrade guarantee

It is your repository. Nothing stops you importing a module Core did not mean for you, and
there is no lint rule here that will scold you for it. Sometimes it is the right call —
you need something today and the surface does not have it.

**What you are trading is the upgrade guarantee, and you are trading it at that moment,
not at the next major version.** kobai's central claim is that upgrading Core is a version
bump rather than a merge. That claim is only made about code attached to the five. The
moment your Project depends on something else, upgrading becomes something you have to
verify by hand, and a minor release is as likely to break you as a major one.

So make the trade visibly. Put it somewhere a person reading your Project will see it —
next to the import, not in a commit message — and say what you needed. Then tell us: **a
Project that cannot do something without reaching outside the surface is evidence the
surface is wrong**, and ADR-0013's standing rule is that we fix the surface rather than
work around it. That report is worth more to kobai than the workaround costs you.

## The list is closed

Five, and growing it is a one-way door. Every promised surface is a permanent constraint on
Core's own refactoring, which is why the list is short and deliberately boring, and why each
addition would have to be its own recorded decision (ADR-0003).

The test has been run **twice** in kobai's own history and held both times. Pluggable Media
storage looked like it needed a sixth mechanism and turned out to be dependency substitution,
which was already number three
([ADR-0026](./adr/0026-postgres-backed-jobs-pluggable-storage-in-process-worker.md)). Then
Fulfilment Strategies did the same thing and more visibly: ADR-0014 had been promising for a
long time that a Variant points at a Strategy "registered by Core or by a Plugin", and a
registry is a surface — so the spine spec would have settled it by accident, whichever shape
the implementation took. It was decided on purpose instead, and the answer was number three
again ([ADR-0052](./adr/0052-a-fulfilment-strategy-is-dependency-substitution.md)). That is
the standard a sixth has to fail before it earns a place.

---

## 1. Configuration — **proven**

**Status: proven end to end.** It is the file the reference Project's own tests boot from,
and both of the mechanisms below reach you through it.

Your Project has one module where everything you have customised is declared:
`kobai.config.ts`. Not a directory of them, and not a plugin that registers itself when
imported — **one file you can read top to bottom and know what your deployment does
differently from stock kobai.**

```ts
import { defineKobaiConfig } from "@kobai/core";
import {
  leadTimeSurcharge,
  madeToOrder,
  madeToOrderMigrationSet,
} from "@kobai/plugin-made-to-order";
import { priceLogMigrationSet, recordPriceResolution } from "@kobai/plugin-price-log";
import { manualPaymentProvider } from "./src/payments/manual.ts";
import { everythingCostsOneCent } from "./src/pricing/everything-costs-one-cent.ts";

export default defineKobaiConfig({
  migrationSets: [priceLogMigrationSet, madeToOrderMigrationSet],
  workflows: {
    "resolve-price": {
      steps: { "select-price": everythingCostsOneCent },
      after: { "select-price": [recordPriceResolution] },
    },
    "place-order": {
      steps: { "apply-adjustments": leadTimeSurcharge },
    },
  },
  payments: { provider: manualPaymentProvider },
  fulfilment: { strategies: { "made-to-order": madeToOrder } },
});
```

**Five keys today**, and every one of them names a *subject* rather than a scalar — a key
holding one setting is how a file gets a second top-level key the day it needs to say
anything else about the same thing
([ADR-0050](./adr/0050-the-idle-window-is-a-projects-the-cap-is-cores.md)):

- `migrationSets` — the Plugin tables your Project has agreed to have.
- `workflows` — the next section, and the flagship.
- `session` — how long a signed-in Merchant stays signed in, as `{ idleWindowMs }`. The one
  key the example above does not use, because this Project is content with Core's default;
  a window Core will not enforce stops the boot rather than being quietly clamped.
- `payments` — the Payment Provider, of which Core ships none. Section 3.
- `fulfilment` — the Strategies your Variants may point at. Section 3 as well.

**Installing a Plugin does nothing.** `@kobai/plugin-price-log` above is an ordinary npm
dependency, and adding it to `package.json` creates no table and runs no code. The two lines
naming it here are what make it real; delete them and it is still installed, still
importable, and still inert. `@kobai/plugin-made-to-order` is the same story with three lines
instead of two — a migration set, a Step, and a Fulfilment Strategy — and neither Plugin has
heard of the other. A Plugin *offers*, and your Project *wires*
([ADR-0017](./adr/0017-plugins-offer-steps-and-the-project-wires-them.md)). That costs a few
lines and buys you a debuggable upgrade: when a version bump changes behaviour, the list of
things that could have caused it is in one file rather than distributed across eleven
packages and decided by import order.

One thing is **not** in this file and you should know where it is: the `logger` is passed to
`createKobai` in your Project's server entry point, alongside `databaseUrl`, because it is
about the running process rather than about what you have customised. See section 3.

## 2. Workflow Step override — **proven**, and the flagship

**Status: proven end to end.** In the reference Project, `select-price` is replaced with a
Step that answers one cent; a Variant whose Price row says `1250` is served `1` by the API,
and `reference/src/kobai.config.test.ts` asserts exactly that through HTTP. The same Project
hands `place-order`'s `apply-adjustments` slot to a Step a *Plugin* offers, and an Order it
places carries the surcharge that Step decided on. Insertion, compensation and composition —
one Step invoking another Workflow — are built and tested. It is still the deepest of the
five, and the one the rest of this page keeps pointing back at.

Commerce customisation is overwhelmingly *process* customisation — tax calculation, price
resolution, shipping rate selection, discount stacking, fulfilment routing, payment capture
timing. Everywhere else, that work bottoms out in copying a service and editing it. Here it
is one named Step in a declared **Workflow**, and this is where kobai intends to be
distinctly better rather than merely comparable (ADR-0003).

### A Workflow is a declaration you can read

`resolve-price` is a value exported from `@kobai/core`, not a description of one:

```ts
import { priceResolutionWorkflow } from "@kobai/core";

priceResolutionWorkflow.describe();
// { name: "resolve-price", steps: [{ slot: "load-prices" }, { slot: "select-price" }] }
```

So "what does kobai do to resolve a price" is answered by the same object that answers "what
does kobai *run*". Two Steps: `load-prices` asks the database what Prices a Variant carries
and applies no rule; `select-price` chooses among them, and *that* is the rule.

**There are two declared Workflows today**, and the second is where the money is.
`placeOrderWorkflow` is `place-order` — the one request that turns a Cart into an Order — and
it declares seven slots, in this order:

| Slot | What it does | Compensation |
| --- | --- | --- |
| `load-cart` | Reads the Cart, its Line Items, and what each one's Fulfilment Strategy answers | — |
| `price-lines` | Invokes `resolve-price` for each line | — |
| `apply-adjustments` | Attaches discounts and surcharges as their own lines — **Core attaches none** | — |
| `calculate-tax` | Works out the tax per line, and on each Adjustment the Order itself carries. Core's returns zero; tax is its own spec | — |
| `hold-reservations` | Claims everything scarce, atomically | Release |
| `take-payment` | Asks your Payment Provider for what the Order comes to | Refund |
| `capture-order` | Consumes those Reservations and writes the immutable Order, in one transaction | none — the point of no return |

Read that order as the argument it is. `capture-order` declares no compensation
because there is nothing it could honestly do —
[ADR-0009](./adr/0009-cart-and-order-are-separate-and-orders-snapshot.md) makes an Order
immutable — so it is
last, `take-payment` sits immediately in front of it because money is the one thing here that
moves outside the database, and `hold-reservations` sits in front of *that* so losing a race
for the last unit costs a Shopper nothing.

Which Workflows you may override is a written-out list rather than a registry —
`CoreWorkflowOverrides` in `@kobai/core` names each one, and adding a line to it is the
decision to expose a Workflow. So the two above are the whole of it, and a third arrives as a
promise somebody made on purpose.

The word for a position is **slot**. It is what an override map is keyed by, and it stays put
when you swap the implementation filling it — after which `slot` and the Step's own `name`
stop being the same thing, which is the point of having two words.

### Replacing one

```ts
workflows: {
  "resolve-price": {
    steps: { "select-price": myStep },        // owns the slot
    after: { "select-price": [observer] },    // watches it; `before` likewise
  },
}
```

Keyed by Workflow, then by what you are doing to it, then by slot. Three things follow from
that shape and each is load-bearing:

- **A slot you do not name is inherited.** Replacing `select-price` leaves `load-prices`
  exactly as Core wrote it. Replacing a Step is not replacing the Workflow, and you do not
  take ownership of code you did not disagree with.
- **Your replacement is checked by the compiler against the Step it replaces.** It must
  accept what the slot is given and produce what the slot produces. A Step that demands a
  narrower input is a compile error, not a runtime surprise — which is what makes swapping a
  Step *safe* rather than merely possible, and most of why kobai is in TypeScript at all
  (ADR-0017). Read the types with `StepInput<W, Slot>` and `StepOutput<W, Slot>` if you want
  to name them yourself.
- **Naming a slot the Workflow does not declare fails loudly**, when the config is applied
  rather than at the request that would have been priced differently. A typo in a slot name
  is not an override that silently does nothing.

**A Step's signature is a promise Core can move, and it has moved once.** #117 widened
`TaxedLines.adjustments` — the type a replaced `calculate-tax` returns — so that a tax Step
has to state a figure for every Adjustment the Order itself carries, a delivery surcharge
being the case it exists for. A Project that had replaced that Step stopped compiling, and no
codemod shipped.
[ADR-0058](./adr/0058-a-promised-surface-may-be-broken-until-the-first-release.md) is the
record: what the argument was, what such a Project does about it in one edit, the rule for
breaking one of the five before kobai's first release, and why a break your own compiler
catches is announced by the compiler rather than migrated by `kobai-upgrade`. Read it before
you conclude a break in this surface was an accident — and if one ever *is*, the rule above
applies unchanged: **a minor release that breaks you inside the five is a bug in kobai**.

A Step is a name and a typed function. `defineStep` is the whole of it:

```ts
import { defineStep, type LoadedPrices, type ResolvedPrice } from "@kobai/core";

export const cheapestWins = defineStep(
  "cheapest-wins",
  (input: LoadedPrices): ResolvedPrice => { /* … */ },
);
```

Give your Step its own name rather than the slot's. A replacement is a different Step and
should say so — the API's response names both the slot and what filled it, which is how you
confirm from outside that your Step is the one that ran.

**Refusing is an answer, not a fault.** Throw `new StepFailure(reason, detail)` when the
Workflow cannot produce its output. An ordinary `Error` keeps travelling and surfaces as a
500, because that is what a bug is.

### Watching one, without owning it

`before` and `after` sit *beside* `steps` rather than inside it, so that owning a Step and
watching one are distinguishable at a glance. They are a deliberately weaker mechanism: **an
inserted Step takes and gives back the same type** — what the slot is about to be given,
before it; what the slot produced, after it — so it can read, log, record and measure, and
cannot change the shape of what flows past. Observation cannot quietly become mutation.

No new machinery enforces that. It is the same compiler check that rejects a bad replacement,
with the input and the output pinned to one type. If insertion could alter the output there
would be no reason to ever replace a Step, and the two mechanisms would collapse into one
nobody can reason about.

A list rather than one Step, because watching composes — your own measurement can sit beside
a Plugin's recording — and the order you write them in is the order they run in.

### Undoing one

A Step that changes something outside the Workflow declares how to undo it, as a third
argument to `defineStep`. When a later Step fails, Core calls the compensation of every Step
that completed, **newest first**, and hands each one the very value its `run` was given — so
a Step that wrote a row can key what it wrote by the value it wrote it for and find it again.

```ts
defineStep("record", write, (input, context) => unwrite(input, context));
```

Compensation ships now rather than later because it cannot be retrofitted cheaply: adding it
afterwards means rewriting every Workflow that exists by then (ADR-0017).

### Invoking another Workflow from a Step

A Step may run another declared Workflow, and there is one way to do it
([ADR-0054](./adr/0054-a-step-may-invoke-another-workflow.md)).

**Core does this to itself, and it is the reason you wire a pricing rule once.**
`place-order`'s `price-lines` runs `resolve-price` per Line Item — so the deployment that
replaced `select-price` charges *its* prices at Capture, from the config line it already
wrote, and the price a storefront was quoted and the price an Order records come out of the
same declaration rather than out of two that have to be kept in step. Nothing in
`kobai.config.ts` mentions `price-lines` to make that happen.

```ts
import {
  defineStep,
  priceResolutionWorkflow,
  runWorkflow,
  StepFailure,
  type PriceResolutionRequest,
} from "@kobai/core";

export const resolvesAPrice = defineStep(
  "resolves-a-price",
  async (input: PriceResolutionRequest, context) => {
    const run = await runWorkflow(priceResolutionWorkflow, input, context);
    if (!run.ok) throw new StepFailure(run.reason, run.detail); // pass the refusal on
    return run.output;
  },
);
```

**It runs your deployment's declaration, not the one you named.** You import Core's
`priceResolutionWorkflow` because that is the only handle the package offers; what actually
runs is the version rebuilt from your `kobai.config.ts`. So a Step you replaced in
`resolve-price` applies wherever `resolve-price` is reached from, including from inside another
Workflow, and you wire it once. Reaching for `priceResolutionWorkflow.run(…)` instead is the
mistake this exists to prevent — it works, and it runs Core's Steps on a deployment that
replaced them.

Three more things hold across the boundary, and each is the same rule you already know:

- **An inner Workflow refusing is a value, not a throw.** You get the whole run back, naming
  the inner slot that stopped and the inner Steps that completed, and you decide: pass it on
  with a `StepFailure`, or carry on. The union is what makes ignoring it impossible — there is
  no `output` to read until `ok` is narrowed.
- **A bug in an inner Step travels as itself**, out through your Step unchanged, and surfaces
  as the 500 it is (ADR-0036).
- **An inner Workflow that completed is unwound when a later Step fails.** You do not have to
  arrange it and there is nothing to remember: your Step's own compensation runs first, then
  the Steps of the Workflow it invoked, in reverse. A Step that fails *after* invoking one
  still has that Workflow unwound, because the work is done either way.

A Workflow that invokes itself resolves to itself and recurses forever. There is no depth limit
and no cycle detection; that is a declaration you wrote rather than something Core can rescue.

### Reading data Core has never heard of

Your Step is handed a context, and that context is **open** by decision. Whatever the caller
sent that Core does not model arrives on `context.metadata` verbatim, and Core never reads a
key out of it. Core's principal entities also carry an untyped `metadata` JSON column.

Between them, that is how a rule Core knows nothing about — a lead time, a customer tier, a
contract — reaches your Step **without changing Core**. If it could not, the extension
surface would be wrong (ADR-0013). The cost is type safety at that one boundary, and it is
paid deliberately.

#### Two ways in, and they are for different things

A storefront fills the open context in either of two places, and both land on the same
`context.metadata`:

| Where | What it is for |
| --- | --- |
| The request's **query string** | Anything a URL may safely hold — a lead time, a customer tier, a flag. Values arrive as **strings**, because a query string has no other type, and a repeated parameter keeps its last value. |
| A **`metadata` object on the request body** | Anything a URL may not: a card token, a completed bank authorisation, anything you would not want in a log. Values arrive as the **JSON you wrote** — a number stays a number, and a nested object stays nested. |

**Only a route that runs a Workflow has an open context at all**, because a Step is the only
thing that reads one. There are two of them: `GET /store/variants/{id}/price`, which has no
body to grow and so has the query-string half alone, and `POST /store/orders`, which has both.
A Cart route takes a body and runs no Workflow, so neither half of a request to one reaches
anything — `POST /store/carts?tier=gold` is a parameter kobai discards.

**Do not confuse this `metadata` with the column of the same name.** The one on `POST
/store/orders` is **never stored** — it lives for the length of the request and is gone. The
Order's own `metadata` is the Cart's, snapshotted at Capture like everything else on an Order
(ADR-0009), so metadata you want kept goes on the Cart, and metadata a Step needs for this one
placement goes here.

**Prefer the body for a credential, and treat that as a rule rather than a preference.** A
query parameter is written to access logs, to proxy logs, and into the `Referer` of anything
your confirmation page loads; a credential in a URL is a credential that has already leaked.
This is the case that made the body exist at all — a `PaymentProvider` reads what it needs out
of this same open context (ADR-0053).

```jsonc
// POST /store/orders?leadTimeDays=3
{
  "cartId": "…",
  "metadata": { "card_token": "tok_visa_4242", "tier": { "name": "gold", "since": 2019 } }
}
```

**A key sent in both halves is refused, at 400 with `reason: "metadata-in-both"`.** Neither
half wins, and that is deliberate: Core has never heard of your key, so choosing between them
would be Core forming an opinion about an input it does not model — and a Step reading a value
that silently came from the other place is the failure worth being loud about. The check is on
**names, never on values**, so the same request is refused however the two happen to compare;
refusing only when they disagree would have your storefront's bug served today and refused
tomorrow. Send each key in one place.

If you serve a Workflow of your own from a route of your own, `openMetadata(url)` and
`openMetadataWithBody(url, body.metadata)` are on the surface, and the second returns either
the merged object or the keys that collided.

## 3. Dependency substitution behind named interfaces — **proven**

**Status: proven, and here is exactly what moved it.** This row read *partial* until the
commerce spine shipped, and the complaint behind that word was precise: there was one named
interface, `Logger`, and both implementations of it were Core's own — so what was proven was
that the seam worked, not that anybody had ever put something of their own through it (#72).
Two things closed that, in the same spec:

- **A Payment Provider from a Project.** Core defines `PaymentProvider` and implements it
  nowhere on purpose (ADR-0053). The only one that exists is `reference/src/payments/manual.ts`
  — the reference Project's own source, reached by Core through one line of `kobai.config.ts`
  and by nothing else. **You get that file too**: `create-kobai`'s template is generated from
  the reference Project, so a scaffolded Project receives `manual.ts` as its own, and a Store
  that takes cards replaces that file's export with an adapter and changes nothing else.
- **A Fulfilment Strategy from a Plugin.** `@kobai/plugin-made-to-order` offers one and the
  reference Project wires it (ADR-0052). Installing that Plugin does nothing; the wiring is
  what lets a Variant point at `made-to-order` at all, and what puts a Lead Time surcharge on
  an Order that a Store without the line would have sold at the ordinary price.

Both are observably different from stock kobai and both are exercised on every commit, which
is the standard #72 set. **What is still absent is interfaces, not evidence** — see the end of
this section.

There are **three** interfaces you can use it on today: `Logger`, `PaymentProvider` and
`FulfilmentStrategy`. Core names a fourth, `ReservationProvider`, and deliberately does *not*
export it. ADR-0018 promises one interface with two providers — Inventory, which exists, and
Capacity, which does not yet — and both of them are Core's, so nothing here hands you a way to
bring a kind of scarcity of your own. That is a decision rather than an oversight: a config
key and an ADR would be needed, and neither exists.

The idea is that where Core needs a collaborator, it names an interface and takes yours. The
oldest is `Logger`:

```ts
import { createKobai, type Logger } from "@kobai/core";

const logger: Logger = { info: (message, fields) => {/* … */}, error: (message, fields) => {/* … */} };
const kobai = createKobai({ ...config, databaseUrl, logger });
```

Two operations, and anything that does them is acceptable. The substitution point is real and
exercised — the reference Project passes a console logger and the test harness passes a
silent one — though both of those implementations are still Core's own. Its *spelling* used to
be out of step with `PaymentProvider`'s and `FulfilmentStrategy`'s, in a way that let a logger
demand more than Core sends; #127 settled that, and the subsection below says what moved.

**`PaymentProvider` is the second, and Core implements it nowhere on purpose** (ADR-0053): a
deployment with none wired boots, serves its catalog and its Admin, and refuses only the
placing of an Order. You wire it as `payments: { provider }`, and the reference Project's own
`manual` provider — its source, in its repository — is the worked example.

**A Fulfilment Strategy is one of these, and not a sixth Extension Point.** ADR-0014 says a
Variant points at a named Strategy that answers three questions about it — does it ship, does
it consume stock, does it have a Lead Time — and that reads like a registry. It is not:
[ADR-0052](./adr/0052-a-fulfilment-strategy-is-dependency-substitution.md) settles it as this
mechanism, reached through the one above it. Core ships `physical` and `digital`; anything else
— a rental, a subscription, made-to-order — is a Strategy a Plugin *offers* or you write
yourself, and your Project *wires* it under the name your Variants point at.
`@kobai/plugin-made-to-order` is the worked example — the Plugin ADR-0014 names, offering the
Strategy below and the Step that charges for a short Lead Time, wired by the reference
Project.

```ts
import { defineKobaiConfig, type FulfilmentStrategy } from "@kobai/core";

const madeToOrder: FulfilmentStrategy = {
  answersFor: () => ({ requiresShipping: true, tracksInventory: false, hasLeadTime: true }),
};

export default defineKobaiConfig({
  fulfilment: { strategies: { "made-to-order": madeToOrder } },
});
```

Until that line exists, a Variant may not point at `made-to-order` at all — creating one is
refused, naming the Strategies this deployment does have (ADR-0017). What the Strategy answers
is what Core acts on: a Variant whose Strategy says it consumes no stock holds no Reservation,
and every Order records what its Strategies answered *at Capture*, as a snapshot that a later
rewiring cannot rewrite.

### What every one of these interfaces looks like

An interface's *shape* is under semver forever from the moment it ships (ADR-0019), so the
four Core has named were deliberately compared against each other rather than each copying
the last. What they agree on is worth knowing before you write one:

- **A plain object type, substituted whole.** No class to extend, no base to inherit, no
  `init` and no `close` — Core never constructs one of these and never disposes of one, so a
  lifecycle would be a contract about something Core does not manage. That is what makes an
  adapter around somebody's SDK a five-line object.
- **Wired in `kobai.config.ts`**, under a key naming a subject — except `Logger`, which goes
  to `createKobai` beside `databaseUrl` because it is about the running process rather than
  about what you customised.
- **A name only where a *record* needs one.** `PaymentProvider` carries one because a Payment
  has to say which system holds the money a year later; `ReservationProvider` carries one
  because a Reservation row names who must give the units back. `FulfilmentStrategy` carries
  none — it is named by the key you wired it under, exactly as a replaced Step is named by its
  slot — and `Logger` needs none at all.
- **Every operation is a property holding a function, never a method** — and that one is
  load-bearing rather than stylistic. TypeScript checks method parameters *bivariantly* and
  function-property parameters *contravariantly*, so only this spelling makes an implementation
  that demands **more** than Core sends a compile error. You do not have to remember it: write
  an implementation that reads a field Core does not send and your own build says so, naming
  the file and the parameter.

The four used to disagree about that last point, and until **#127** they were two safe and two
not. `Logger` and `ReservationProvider` were declared with methods, so this compiled:

```ts
const logger: Logger = {
  info: (message: string, fields: { requestId: string }) => console.log(fields.requestId),
  error: () => {},
};
```

and then Core called `logger.info("listening")` with no second argument and your logger read
`.requestId` off `undefined`. Both have moved to the property spelling, which is a *tightening*
of a surface ADR-0019 makes permanent — takeable because nothing has been released yet, on the
rule [ADR-0058](./adr/0058-a-promised-surface-may-be-broken-until-the-first-release.md) states:
a promised surface may be broken outright before the first publish, and a break your own
compiler catches is announced by the compiler rather than by a codemod.

**Almost nothing was broken even so.** Every logger that accepted what Core actually sends
still compiles. Two shapes stop compiling, and both were already reading a key off `undefined`
at runtime: one demanding a **narrower** `fields` than `Record<string, unknown>`, and one
declaring `fields` **required** rather than optional. The second is a one-character fix —
`fields?` — and the first is a finding about the logger. The break itself is in ADR-0058's
register, which is the list to date any compile error you hit against.

**What is not here yet, and this is the honest half of the status above.** ADR-0026 names
Media storage as the archetypal case of this Extension Point: a pluggable driver defaulting to
local disk, with an S3-compatible one shipped. It also names a Postgres-backed job queue.
**Neither exists.** The walking-skeleton spec put both out of scope on purpose and the
commerce spine spec renewed the exclusion — kobai's first periodic work, the sweeper that
releases lapsed Reservations, is a plain `setInterval` and explicitly *not* a job
([ADR-0057](./adr/0057-the-reservation-sweeper-is-an-interval-not-a-job.md)), which is a thing
the queue spec will have to migrate rather than a queue you can attach to.

So do not read ADR-0026 as documentation of something you can configure — read it as the
argument for why storage did not need a sixth Extension Point. Moving this row to *proven*
says the mechanism has carried somebody else's code; it does not say the interfaces you
were promised are all here.

The database is not substitutable either, and is not meant to be: `createKobai` takes a
connection string, not a handle. Postgres is a decision, not a driver
([ADR-0011](./adr/0011-postgres-and-drizzle.md)).

So: if you need to substitute something none of the three names, there is nothing to attach
to, and that is a gap to report rather than a mechanism to discover.

## 4. Events — **promised only**

**Status: promised, and not built.** There is no event bus, no emitter, no subscription API
and no event type anywhere in `@kobai/core`. Nothing is missing from this page — there is
nothing yet to document.

The intent is what you would expect: react to something having happened without standing in
the path of it. Where Step override is for changing what the system *decides*, an event is
for what you do *afterwards* — and the two are deliberately different mechanisms, because a
subscriber that could change an outcome is a Step with worse ergonomics and no type check
(ADR-0003).

**Do not build on this yet, and be careful how you read the promise.** ADR-0003 commits
kobai to stability on events *once they exist*. It does not tell you what they will look
like, and nothing about the eventual shape can be inferred from anything currently in the
tree. If you need to react to something today, an inserted `after` Step at the right slot is
the honest substitute — with the honest caveat that it runs *inside* the Workflow, so it is
in the path of the thing it is watching in a way an event would not be.

## 5. Admin UI slots — **promised only**

**Status: promised, and not built.** There is no slot registry, no declared position, and no
way for a Plugin to contribute UI to the Admin. The only "slot" kobai has is the Workflow
slot of section 2 — and do not be misled by the `data-slot` attributes throughout the
Admin's components, which are shadcn's own styling hooks and have nothing to do with this.

What exists instead — and it is a different thing, so do not mistake one for the other — is
that **the Admin's source is vendored into your Project.** It arrives as a directory of
ordinary files — `reference/admin/` in this repository — React on Vite, with shadcn/ui
components that are source rather than a dependency, because that is what `shadcn add` does
([ADR-0033](./adr/0033-the-admins-shape-a-vendored-vite-spa-at-a-path.md)). Your formatter
formats them and your typechecker checks them. To change the Admin today, **edit the file.**

That is not an Extension Point and Core makes you no promise about it, because it is not
Core's code any more — it is yours, from the moment it lands, and Core will never ask for it
back (ADR-0001, ADR-0010). The upgrade consequence is the shadcn one: you keep
your changes forever and you pick up improvements by hand.

The Admin does have one constraint worth knowing, because it constrains what you can build
into it: **the Admin uses only the public API**, through the generated `@kobai/client`, and
gets no privileged back door
([ADR-0010](./adr/0010-the-admin-ships-in-one-container-and-gets-no-private-api.md)). If
something you want to add to the Admin cannot be done through the API, that is a finding
about the API rather than a reason to reach around it — the same rule kobai holds itself to.

---

## Where to look next

- [ADR-0003](./adr/0003-the-extension-surface-and-what-we-promise.md) — the surface, and why
  it is closed. The decision this page reports.
- [ADR-0019](./adr/0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md)
  — Plugins are npm packages, and what semver does and does not cover.
- [ADR-0017](./adr/0017-plugins-offer-steps-and-the-project-wires-them.md) — why a Plugin
  offers and a Project wires, and why a replacement is type-checked.
- [ADR-0058](./adr/0058-a-promised-surface-may-be-broken-until-the-first-release.md) — the
  one break taken in this surface so far, and the rules it was taken under.
- [ADR-0013](./adr/0013-core-owns-no-lead-time-pricing-and-workflow-context-is-open.md) — the
  open context, and the standing rule that a surface which cannot do the job is the thing to
  fix.
- **Your own `kobai.config.ts`** — and, if you want to see one that is kept honest,
  `reference/kobai.config.ts` in kobai's repository, which is the same file for the reference
  Project and is exercised on every commit
  ([ADR-0029](./adr/0029-the-reference-project-is-the-release-gate-and-content-is-built-first.md)).
