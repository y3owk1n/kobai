# Core emits, the Project wires a subscriber, and delivery is in-process

> **Amended below (#338): the first Event is `fulfilment-was-dispatched`.** This record named it
> `fulfilment-dispatched`, which is also the `reason` a Merchant is refused a *second* dispatch
> with — two opposite facts under one spelling. Everything else here stands, the naming rule
> included; what the amendment adds is the clause that keeps an announcement and a state apart.
> **The name is corrected in place wherever this record writes it**, with the old one struck
> beside it, so nothing below can be copied wrong;
> [Amendment: an Event says `was`](#amendment-an-event-says-was-338) is the argument.

Events are one of [ADR-0003](./0003-the-extension-surface-and-what-we-promise.md)'s five Extension
Points — the fourth, as `docs/extension-points.md` numbers them, since that ADR names five and
numbers none — and the one that has never existed in any form: #13's audit found no bus, no
emitter, no subscriber and no event type anywhere in `@kobai/core`, and `docs/extension-points.md`
has said *promised only* ever since. This record is what the promise means. **It ships nothing**:
the surface is built in #211, where Fulfilment dispatch first gives kobai something to announce.
It is decided ahead of that build because
[ADR-0019](./0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md) puts a
payload under semver from the day it exists, which makes a pull request the most expensive place
to settle its shape.

## What is decided

- **Core emits, and nothing else does.** An Event is a fact about something kobai did. A Plugin
  does not emit and a Project does not emit, so the set of Event names is Core's the way the set
  of Workflow slots is.
- **A Plugin offers a Subscriber and the Project wires it**, by Event name, in `kobai.config.ts`
  — [ADR-0017](./0017-plugins-offer-steps-and-the-project-wires-them.md)'s rule, unchanged:

  ```ts
  // kobai.config.ts
  events: { subscribers: { "fulfilment-was-dispatched": [emailTheShopper] } },
  ```

  The name is #338's; the shape is this clause's subject and is unchanged. A subject rather than
  a bare map (ADR-0050), so that the day kobai has something else to say about events — durable
  delivery, below, is the obvious candidate — it is a key beside `subscribers` rather than a
  reshape of every Project's config file.
- **Names are kebab-case and flat** — ~~`fulfilment-dispatched`~~ `fulfilment-was-dispatched`
  (**amended by #338**), subject then what happened. kobai already names Workflows, Steps and
  refusal `reason`s that way, and a dotted `fulfilment.dispatched` would invent a hierarchy the
  registry does not have. Flat and kebab-case stand whole; what the amendment adds is that an
  Event announcing a transition says `was`.
- **There is no wildcard.** A Subscriber names one Event. Nothing may ask for all of them.
- **An Event is emitted after the transaction that made the fact has committed, and never from
  inside a Workflow Step.**
- **A Subscriber cannot refuse.** `StepFailure` has no meaning here and Core does not look for
  one; anything a Subscriber throws is a bug, and it is caught, logged through the deployment's
  `Logger`, and changes nothing about the answer the caller gets.
- **Subscribers run in the order the Project wrote them, one after another, awaited, and every
  one is called** — including the ones after a Subscriber that threw. Core attempts each exactly
  once and **there is no retry**.
- **Delivery is in-process, and events are not durable.** ADR-0026's job queue is **not** pulled
  into #211, and the sweeper debt
  [ADR-0057](./0057-the-reservation-sweeper-is-an-interval-not-a-job.md) owes it stays exactly
  where it is.
- **A payload is plain JSON data, produced by Core and read by a Subscriber**, and it carries the
  identity of what happened and the facts of the transition — never a copy of the record it
  concerns.

## Why the Project wires it, and why that is not a formality

ADR-0017's argument is about Steps and it applies here with more force, because an Event has no
type check to fall back on. A replaced Step at least has to satisfy the slot's input and output,
so a Plugin that installed one by being installed would still be constrained by the compiler. A
Subscriber returns nothing and decides nothing, so a Plugin that registered one at load time
would be running code in a deployment that has no compile-time trace of it at all — and the
symptom, when eleven Plugins are installed and an upgrade starts sending two confirmation emails,
is a behaviour with no file to open. Load order arbitrating which of them runs first is the
second half of the same failure.

So installing a package subscribes to nothing. The line in `kobai.config.ts` is what makes a
Subscriber run, exactly as a line there is what makes a Plugin's Step run and what makes its
Fulfilment Strategy exist ([ADR-0052](./0052-a-fulfilment-strategy-is-dependency-substitution.md)).
This is story 23 of #211 and it is the whole reason the mechanism is worth having: a Developer
reads one file and knows what their deployment does.

**Core being the only emitter** is the same rule looked at from the other end. An Event name is
promised forever under ADR-0019, and a name-space two packages may both write into is a registry
whose contents depend on what is installed — the thing this Extension Point exists to be an
alternative to. A Plugin with something to announce has ways to say it already: it exports a
function the Project calls, or it offers a Step the Project inserts. Extension Point 4 is for
reacting to what **kobai** did. If a first-party Plugin ever needs to announce something Core has
no counterpart for, that is a new decision and not an omission here.

## Why a Subscriber cannot change what it hears about

Story 24 asks that a Subscriber which throws must not undo what emitted. The cheap way to get
that is a `try`/`catch` around the call. The honest way is to make it structurally impossible,
and that is what "after the transaction has committed, and never from inside a Step" buys: at the
moment a Subscriber runs there is nothing left to undo, because the row is written and the run
that wrote it is over. The `try`/`catch` is still there — a throw must not become a 500 on a
route that succeeded — but it is not what the guarantee rests on.

The rule against emitting from inside a Step is the load-bearing half.
[ADR-0036](./0036-unwinding-is-exhaustive-and-never-replaces-what-stopped-the-run.md) makes
unwinding exhaustive: every completed Step's compensation is attempted when a later Step fails. A
Step that emitted would be the one piece of work in that region with no compensation available,
because an Event that has already been delivered cannot be recalled — a confirmation email for an
Order that was then unwound, and a Store with no way to tell the Shopper otherwise. So Core emits
from the route, after the Workflow has returned and the transaction has committed, and a
Subscriber is never inside an unwindable region. It follows that a Subscriber declares no
compensation and there is nothing for one to compensate.

For the same reason a Subscriber is handed the payload **and nothing else** — no transaction, no
database handle, no Workflow context. The two things it might plausibly want, a logger and the
deployment's own configuration, are things the Project is holding at the moment it wires, so a
closure has them; a Plugin that needs configuring exports a factory, the way `stripePayments`
already does. A second parameter would be a permanent shape for no proven need, and the one thing
a context could usefully contain — the transaction — is precisely the thing that would let a
Subscriber undo what emitted.

**Every Subscriber is called even after one throws**, and that is ADR-0036's argument reached a
second time: the failure that matters is not one integration being broken, it is one broken
integration silencing the three wired after it. Sequential and in wired order rather than
concurrent, because a Project that wrote two in an order chose that order, and because
`Promise.all` rejects on the first throw — which is the behaviour just refused. A failed
Subscriber is reported in the log and nowhere else: the response body a Merchant's Admin or a
storefront parses should not grow a field about whether somebody's email integration is working,
which is ADR-0036's reasoning about `uncompensated` applied to a smaller fact.

## Why in-process, and what is given up

**Events are in-process. They are not durable.** Nothing is written to Postgres when an Event is
emitted, nothing is retried, and an Event whose process dies between the commit and the call is
lost.

Durable delivery is a queue, and a queue is a spec nobody has written. ADR-0057 already listed
what one costs — a retry policy, a visibility window, a failure record, a worker lifecycle, and a
story about two workers taking the same row — and refused to build it in order to run a sweep.
The list has not got shorter. Building it here would mean #211 shipping ADR-0026's queue, migrating
ADR-0057's sweeper onto it, and *then* getting to the Address, the shipping charge and the
Fulfilment lifecycle that spec is actually about, in exchange for a delivery guarantee wanted by
the one consumer that exists.

The loss is also smaller than it first reads, because **the fact is durable even when the Event is
not**. A dispatched Fulfilment is a committed row with a state and a timestamp; what can be lost is
the notification, not the record. A Subscriber whose work must never be skipped can be written
against the row, and a deployment that wants durable delivery to *its* systems gets it by wiring a
Subscriber that enqueues into a queue it already runs and returns — which is a Project owning its
own reliability rather than kobai owning it for everybody.

What is given up is real and worth naming: **at most once, and no proof of delivery.** kobai's
events are not webhooks, and a Developer who reads Extension Point 4 as one will be wrong. The
day a Subscriber's work is something a Merchant would have to reconcile by hand if it were
skipped — an accounting export, a stock sync a warehouse acts on, a partner billing off a
delivery — is the day this is re-decided, and the re-decision is ADR-0026's queue with ADR-0057's
sweeper migrated onto it. That is a later spec with its own budget, not a discovery mid-#211.

Three things are decided now so that the later move is additive rather than a break:

- **A payload is JSON data** — strings, numbers, booleans, `null`, and nested objects of those.
  No `Date`, no entity object, no handle. Timestamps are ISO 8601 strings, which is what every
  other kobai boundary already serves. A payload that could not survive a round trip through
  Postgres would make durability a breaking change to every Event at once.
- **A Subscriber's return value is never read.** It returns `void` or a `Promise<void>`, so a
  durable path need not invent a meaning for something it was handed.
- **A Subscriber must be idempotent.** In-process delivery is at most once; a durable one would be
  at least once. Saying so from the first day is what stops the delivery guarantee tightening into
  a semver break.

## Why the payload is thin, and which way its type runs

The direction is the property to preserve (ADR-0019), and it is the argument `FulfilledVariant`
and `FulfilmentAnswers` make in `fulfilment/strategy.ts`. A payload is **produced by Core and read
by a Subscriber**, which is `FulfilledVariant`'s direction: Core may **add** a field to a payload
and every Subscriber written against today's shape still compiles. A Subscriber is a function
*type* rather than a method signature, so `strictFunctionTypes` checks its parameter
contravariantly and one that demands more than Core sends is a compile error rather than an
`undefined` at run time — the same spelling, for the same reason, as
`FulfilmentStrategy.answersFor`.

What may never happen to a payload without a major: removing a field, renaming one, widening a
`string` to `string | null` — the direction that breaks a reader — or, the one no compiler
catches, keeping a field's name and changing what it means. **Narrowing** runs the other way and
is safe for the same reason adding a field is: a Subscriber that handled a `null` it can no
longer be sent still compiles, and the branch is simply never taken.

**A payload carries the identity of what happened and the facts of the transition itself, and
nothing else.** Not a copy of the Order, not the Shopper's email, not the lines. Two reasons. A
copied field is a second promise about data the HTTP surface already promises (ADR-0060), and two
copies of a fact drift. And a payload is read at an unknown later moment: a copy of a record is
stale by construction, while an identifier is not. A Subscriber that needs more reads it back
through the surface it is already allowed to use.

That errs deliberately on the thin side, because thin can grow and fat cannot shrink: adding the
field a Subscriber turns out to want is the additive change this record expressly permits, and
removing one it does not is a major version.

**A new Event is additive too**, and the ban on a wildcard is what makes that true: with no way
to subscribe to everything, nothing starts receiving an Event added in a minor without a line
being written for it.

## The first event: `fulfilment-was-dispatched`

*Named ~~`fulfilment-dispatched`~~ until #338 — the amendment below is why. The payload, and
every argument about it in this section, is unchanged.*

#211 commits to the first consumer, and #320 builds the lifecycle it belongs to — a Fulfilment
moves dispatched, delivered or cancelled, per Fulfilment and never on the Order. **Dispatch is the
first Event**, emitted by the `/admin` action route after the transition has committed:

```ts
type FulfilmentDispatched = {
  readonly fulfilmentId: string;
  readonly orderId: string;
  readonly trackingReference: string | null;
  readonly occurredAt: string;
};
```

- `fulfilmentId` and `orderId` — what moved, and the Order it is part of. The Order's identifier
  is here rather than looked up because #320 decides a Fulfilment is read **through** its Order:
  without it a Subscriber holds the identity of something it has no route to read.
- `trackingReference` — the opaque string recorded at dispatch, exactly as recorded. kobai parses
  nothing out of it and models no carrier (#211). `null` when the transition recorded none; if
  #320 settles that a dispatch must always carry one, the field is simply never null, which is
  not a change of shape.
- `occurredAt` — when the transition was committed, ISO 8601. Every payload carries one, because
  a Subscriber may run late and "now" is not when it happened.

Nothing about the Fulfilment beyond the transition: not its Strategy, not `requiresShipping`, not
its lines. Those are on a row the Subscriber can read, and the paragraph above is why they are not
copied here.

Delivered and cancelled get Events on the same terms when something wants them. They are not
added speculatively — an Event nobody subscribes to is a promise with no consumer, which is what
ADR-0003 exists to prevent.

## Amendment: an Event says `was` (#338)

**Raised as #338 and built there, one ticket after the surface shipped in #322.** This section is
the operative text for what an Event is called, and the clauses above that name it are corrected
in place with the old name struck. Nothing else in this record moves — not the naming rule it
amends, not the payload, not the delivery guarantee.

**What this record said:** the first Event is `fulfilment-dispatched`, kebab-case and flat,
subject then what happened.

**What it says now:** it is **`fulfilment-was-dispatched`**, and the rule that produced it is
that **an Event announcing a transition names the transition in the past tense, with `was`**.
Kebab-case and flat is unchanged, and so is subject-first. Delivered and cancelled, when
something wants them, are `fulfilment-was-delivered` and `fulfilment-was-cancelled`.

**Why the first name did not survive.** `fulfilment-dispatched` is also
`FULFILMENT_REFUSALS.dispatched` in `packages/core/src/fulfilment/lifecycle.ts` — the `reason` a
Merchant is refused a move *with*, meaning **this one has already gone** — and the two are
opposite facts. This record and #320 each followed the same subject-then-state rule and arrived
one ticket apart, so nothing was in a position to notice. **They never collide mechanically**:
one is a string in a refusal body a client branches on, the other a key in `kobai.config.ts`, and
no compiler or runtime is confused by either. What collides is what a person reads — in a log
line, in a doc that shows both, in a Developer's memory of which one they were told about.

**Why the Event is the side that moved.** The refusal set satisfies
``Record<FulfilmentState, `fulfilment-${FulfilmentState}`>``, so the four words are *derived*
from the state union and the set is exhaustive by construction rather than by care. It is also
promised HTTP surface (ADR-0060), with a generated description and a generated client behind it,
where an Event is a name in a config file. And the two sets are naming two different things once
the difference is seen: a refusal names the **state** a Fulfilment is in, an Event names the
**transition** it just made, so the tense is the honest distinction rather than a disambiguating
suffix.

**Why it is a rule and not one string.** The collision is systematic rather than a coincidence of
one word: three of the four refusals name a state a Fulfilment *moves into*, so each would get an
Event on this record's own terms, and every one of them would have collided identically. A rename
that fixed `dispatched` alone would have left the same ticket to be written twice more.

**What it cost, and why it had to be now.** An Event name is under ADR-0019 from the day it
ships, and this one shipped in #322. Nothing is published, so
[ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md)'s licence is what
pays for it and the break is registered there. **The wire did not move**: an Event is not on the
HTTP surface, so `packages/core/openapi.json` and `@kobai/client` are byte-identical across this
change, and the four refusal words are exactly where they were.

**What holds it from here on.** `packages/core/src/events/events.test.ts` asserts that
`Extract<EventName, FulfilmentTransitionRefusal>` is `never`, which the gate's `typecheck` step
runs. Both sides are derived — the Events from `KobaiEvents`, the words from the state union — so
a fifth state, or an Event added under a state's name, reddens the build naming the spelling.
The rule is written on `KobaiEvents` as well, where somebody about to add an Event will read it.

**The payload's *type* keeps its name, and that is the boundary rather than an oversight.**
`FulfilmentDispatched` is what a Subscriber annotates with, and nothing on the refusal side is
called that — the type there is `FulfilmentTransitionRefusal` — so there is no second collision
to end. The guard above is over the strings a Project **writes**, which is where the confusion
was; renaming an exported type as well would be a second break on this record's promised surface
bought with nothing but symmetry.

Two other answers were available and are recorded because the argument for this one is only as
good as its rivals:

- **Rename the refusals instead**, to `fulfilment-is-${FulfilmentState}`. This does *not* loosen
  the derivation — the template stays a template — and it arguably reads better, since the
  refusal really does mean *it is already dispatched*, and it would have left the Events with the
  names every events surface gives them. Rejected on cost, which is the only place the two sides
  differ: four promised `reason` strings, a regenerated description and client, and the Admin's
  own refusal map and Order screen — against one Event name and no generated artifact at all.
  Both are free under ADR-0058 today and neither is free after the first publish; the cheaper one
  buys the same separation.
- **Leave them and record the collision on both sides**, which is what #322 did on `KobaiEvents`
  and is a legitimate answer for something that never collides mechanically. Rejected because the
  note is a permanent cost paid by every reader in exchange for a rename that is free exactly
  once, and because the note would have had to be written twice more as delivered and cancelled
  got Events.

## Considered options

- **A Plugin subscribes by being installed**, the way most plugin systems work. Rejected — it is
  ADR-0017's rejected shape with the type check removed, and the argument there is unchanged.
- **Events on ADR-0026's Postgres queue from the start.** Rejected, above: it pulls an unwritten
  spec plus ADR-0057's migration into #211 to serve one consumer, and the direction is reversible
  — the three commitments in *Why in-process* are what keep it so.
- **Emitted inside a Workflow Step, so an Event is part of the run.** Rejected: it puts the one
  uncompensatable side effect inside the region ADR-0036 promises to unwind exhaustively.
- **A Subscriber that may refuse, by throwing `StepFailure`.** Rejected: that is a Step, and it
  has one already — with a type check, a slot, and a compensation. An Event that could change an
  outcome is Extension Point 2 with worse ergonomics, which `docs/extension-points.md` has said
  since #13.
- **Fire the Subscribers without awaiting them, so the route answers immediately.** Rejected: a
  floating promise cannot be observed by a test, and an unhandled rejection ends a Node process —
  the same hazard ADR-0057 handles for the sweeper.
- **One `Subscriber` that receives every Event, narrowing on a discriminant.** Rejected: it makes
  adding an Event a breaking change for everybody who wrote an exhaustive `switch`, and it means
  a Subscriber starts receiving Events nobody wired it for.

## Consequences

- **The Extension Points stay five.** This fills number four rather than adding one, and it needed
  no new mechanism to reach configuration or a Plugin — the consistency check ADR-0026 asked for
  and ADR-0052 ran, a third time.
- **`docs/extension-points.md` is unchanged by this record.** The row stays *promised only* until
  the surface ships in #211: a decision is not a proof, and that page's whole value is that its
  status column means something.
- **ADR-0069's named risk is discharged in the direction that costs nothing.** The job queue does
  not arrive with spec 5. ADR-0026 stands untouched as the decision for background *work*, and
  ADR-0057's debt is still owed to whichever spec finally builds it.
- **A slow Subscriber slows the route that emitted.** Today that route is a Merchant's dispatch on
  `/admin`, which is the right person to pay it and the right place for the signal to show up. An
  Event on a Shopper's path — a placement — is a harder trade, and it is the second thing that
  would reopen durability.
- **A Subscriber is not a place to put work that must happen.** It is a place to react. The
  difference is the whole of what "in-process, at most once, no retry" means, and it belongs in
  the documentation the surface ships with rather than only here.
- **#70 stays open.** It closes when the surface exists, not when it is decided.
