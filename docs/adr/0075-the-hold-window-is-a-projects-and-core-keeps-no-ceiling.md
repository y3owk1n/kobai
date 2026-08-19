# The hold window is a Project's, and Core keeps no ceiling over it

A Project sets how long a Reservation hold stands, in `kobai.config.ts`, as
`reservations.holdWindowMs`. Core keeps a **floor** of one minute and **no ceiling at all**,
and a window below the floor stops the boot rather than being clamped to fit. A Project that
says nothing gets the fifteen minutes every deployment has had since ADR-0018 — exactly.

[ADR-0070](./0070-a-payment-the-shopper-completes-at-their-bank.md) is what made this due. It
records that "the hold's TTL is a Project's, with Core's default. ADR-0050's precedent
exactly", because a hold now spans a Shopper walking into their banking app, and how long that
takes is a fact about a Store's Shoppers and their banks that Core cannot know. The constant's
own docblock had said it was a constant "because no deployment has yet needed to say anything
different, and a key is a promise (ADR-0050)" — which was the correct answer right up until a
deployment needed to, and applying that trigger consistently is what this record is.

It lands **before** the hold route, deliberately: `POST /store/carts/{id}/holds` should arrive
tunable rather than shipping a number a Developer has to petition for, and the hold route's
ticket should be about holding stock rather than about configuration.

## What is decided

- **`reservations` is a key in `kobai.config.ts`, holding `holdWindowMs`.**
  [ADR-0050](./0050-the-idle-window-is-a-projects-the-cap-is-cores.md)'s shape, including the
  part that is easy to skip: nested rather than a top-level `reservationHoldWindowMs`, because
  every key in that file names a *subject* a Project customised and a bare number would be the
  first that is not. The next thing a deployment needs to say about its Reservations goes
  beside it instead of forcing the shape after the fact.
- **A window below one minute, or one that is not a whole number of milliseconds, throws from
  `createKobai`** — before a connection pool or a route exists, with a message naming
  `reservations.holdWindowMs`, the value it was given and the bound it missed. **Nothing is
  clamped**, for ADR-0050's reason: a deployment whose holds quietly last something other than
  what its config file says is a bug found by a Shopper who paid at their bank and came back to
  `insufficient-stock`.
- **There is no upper bound.** See below.
- **The window reaches the Step on the Workflow context**, as `holdWindowMs`, the way the
  Payment Provider and the Fulfilment Strategies do (ADR-0053, ADR-0052) and for the same
  reason: a Step is a module-level declaration a Project may replace, so there is nothing to
  hand a dependency to at construction time.
- **`holdReservations` takes the window as a required argument, and the context key is
  optional. Those are two different seams and the difference is deliberate.** ADR-0070 is about
  to add a second thing that claims stock, and it must claim for the same length as the first;
  a required argument makes forgetting that a compile error rather than a second answer. The
  *context* key cannot be required without making every Workflow anyone assembles in a test
  carry a number the test has no opinion about, so it takes `fulfilment`'s reading exactly —
  absent means Core's default, and `createStoreRoutes` fills it once for every route rather
  than per route. **That leaves one place where a mistake is silent**: a future context-builder
  that omits it holds stock for fifteen minutes whatever the Project configured. It is the same
  exposure `workflows` has carried since #113, it is named on `StoreDependencies.holdWindowMs`
  where a second builder would be written, and the alternative — a required context key — buys
  it at the cost of the seam ADR-0003 keeps a Workflow testable through.
- **`DEFAULT_RESERVATION_HOLD_WINDOW_MS` is the constant's new name.** It is a default now, not
  the rule, and a name that said otherwise is the staleness ADR-0050 renamed
  `DEFAULT_SESSION_IDLE_WINDOW_MS` to avoid.
- **Nothing about today's behaviour changes.** A Project that configures nothing holds stock
  for exactly as long as it did before this key existed, and **no existing assertion moved**.
  One existing test file was edited and it is worth naming the kind of edit it was:
  `http/openapi.test.ts` builds an app by hand rather than through the harness, so it names the
  new dependency at its construction site — the same line `sessionPolicy` occupies. Nothing it
  asserts changed, because nothing it asserts moves with either number.
- **Nothing published moves.** Unlike the session's window, which `Session.expiresAt`'s
  description reports and which therefore made two routes per-instance, no route on the surface
  answers with a hold's deadline yet — so `packages/core/openapi.json` is untouched and the
  description of stock kobai is still the description of every deployment. The hold route will
  answer with a deadline it computed, which is a value rather than a documented constant, so
  that stays true.

## Why there is no ceiling, where sessions have one

This is the half of ADR-0050 that does not transfer, and the asymmetry is worth stating because
it looks like an oversight.

**ADR-0050's cap exists because an idle window is renewed by traffic.** A session that activity
extends is a session that never ends, so the window bounds an *abandoned browser* and bounds
nothing at all against a thief who keeps using a stolen token — their own requests are what
keep it alive. The cap is the only bound left once somebody's activity is renewing the window,
and it is the one number in that pair with nothing above it.

**Nothing renews a hold.** It is written once, with a deadline, and the sweeper gives it back at
that deadline; no request extends it and no traffic keeps it alive. The window therefore already
*is* the bound, and there is no gap above it for a ceiling to fill. The structural argument that
produced the twelve-hour cap has no counterpart here.

What a long window costs is different in kind, too. An over-long session is a security exposure
belonging to everyone the deployment serves. An over-long hold is **stock left unsellable after
a Shopper walked away** — this Store's own inventory, this Store's own Shoppers, this Store's
own money, recovered in full by the sweeper the moment the window lapses. That is untidy rather
than unrecoverable, and it is a Merchant's trade against their own abandonment rate.

And it is precisely the number ADR-0070 says Core cannot know. A ceiling would be Core guessing
at the bank-redirect latency it has just recorded that it has no way to guess at — and the
guess would be wrong in the direction that costs a Shopper money, because a deployment whose
Shoppers really do take forty minutes in a banking app and is capped below that is a deployment
that takes payments it cannot fulfil.

The last piece is ADR-0050's own trigger, applied consistently: the window becomes configurable
because a deployment asked; **nobody has asked for a bound on how long a Store may hold its own
stock**, and "some deployment might set it too high" is the reasoning ADR-0045 and ADR-0050 both
explicitly declined to act on. A ceiling stays addable later at no cost to any Project already
under it, which is the cheap direction to leave this in; a deployment that wants one today
enforces it where it builds its own config, which is a line of its own code rather than an
argument with Core.

## The floor is Core's, and it is about kobai working rather than about inventory

The floor is the one bound that is not the Merchant's business, because below it kobai stops
being correct rather than becoming imprudent.

Everything between `hold-reservations` and `capture-order` happens inside the window, and
`take-payment` is among them — a round trip into somebody else's system. A window the run
overruns is released by the sweeper from under itself, and `consumeReservations` then raises
**after the money has moved**: a Shopper charged, and no Order. That is the one failure in the
Reservation module that costs a Shopper rather than costing the Store a few minutes of
unsellable stock, and it is the failure ADR-0070 exists to close rather than to open somewhere
else.

One minute is also the granularity at which a lapsed hold is noticed at all — `SWEEP_INTERVAL_MS`
is a minute — so a window below one sweep asks for a precision nothing acts on. It is stated as
an absolute constant rather than derived from the sweep interval, which a Project may pass its
own value for: two numbers in a relation that can be got wrong in two directions at once is the
trap ADR-0050 named when it kept "the idle window may not exceed the cap" a bound against a
constant.

**It is a floor rather than a warning** for the reason nothing is clamped: a deployment that had
been told its thirty-second window was unwise and served it anyway would discover the
consequence as a charged Shopper with no Order, which is the worst place to discover anything.

## Consequences

- **`kobai.config.ts` has six keys**, and the second that can fail a boot. Both failures are
  numbers in that file, and both are paid loudly.
- **A number is threaded where the session threads a `SessionPolicy`, and that follows from the
  ceiling rather than from taste.** `SessionPolicy` is an object because the cap is part of the
  answer even though no Project sets it, and "everything that computes a deadline needs both" —
  reading one from an argument and the other from a module constant is how the two drift. There
  is no second number here: the floor is spent at boot and nothing downstream consults it. A
  one-field policy object would be the shape without the reason, which is the
  Speculative Generality ADR-0050 spent a paragraph avoiding in the other direction. The day
  this key says a second thing, it becomes an object and the callers change with it.
- **Two windows in that file are bounded differently, and a reader will ask why.** The answer is
  on the key — `ReservationsOptions.holdWindowMs`'s docblock carries the whole asymmetry, not a
  pointer to it — because somebody changing the number is reading the type, not this file.
- **`WorkflowContext` grows a fourth threaded dependency.** It is optional, and absent means
  Core's fifteen minutes rather than no window, so a Workflow assembled in a test behaves as a
  deployment that configured nothing does. A route that builds a context without it holds stock
  for the default whatever the Project configured, which is the silent failure #113 named for
  `workflows`; `createStoreRoutes` therefore threads it once rather than per route.
- **The reference Project configures nothing**, deliberately and for ADR-0050's reason: it is
  the deployment that proves the defaults are still what a Project gets for free (ADR-0029).
  What a configured window does is asserted against a booted kobai in
  `packages/core/src/reservation/reservation.test.ts`, including that a window far above
  anything Core would have chosen is accepted — which is the assertion that would fail if
  somebody added a ceiling without coming back here.
