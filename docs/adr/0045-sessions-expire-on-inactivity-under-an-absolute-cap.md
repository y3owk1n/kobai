# Sessions expire on inactivity, under an absolute cap

A Merchant session ends after **30 minutes with no requests**, and every authenticated request
pushes that deadline out again. No session outlives **12 hours from sign-in**, however hard it
is used. The extension is written to `core_session` at most **once a minute per session**, not
once per request.

Before this, a session was given a fixed 12 hours at sign-in and nothing moved it (#4). Its
author flagged that as a default rather than a decision, and it is the wrong default: spec
story 49 asks to be signed out "so that an unattended browser is not an open door", and an
expiry fixed at sign-in answers the letter of that while inverting the spirit. It signs out a
Merchant who has been working in the Admin all afternoon, and it leaves a browser abandoned
ten minutes after sign-in open until evening. **The door it closes is the one nobody was
standing at.** Measuring from the last request is what makes the window mean what story 49
says it means.

## What is decided

- **The window is idle time, and any authenticated request resets it.** Resolving a session is
  what extends it, so extension is not a step a caller can forget — and forgetting it would
  sign a working Merchant out. There is no second entry point to keep in step.
- **There is an absolute cap, and it is 12 hours from sign-in.** See below; this is the
  decision the ticket asked to be taken deliberately rather than by omission.
- **The window is hardcoded**, in `packages/core/src/auth/session.ts`, as three exported
  constants with the reasoning on them. Nothing about building this made a knob necessary.
- **Nothing about the cookie changes.** ADR-0032 gives it no `Expires` and no `Max-Age`, and a
  sliding window is a second reason for that rather than a reason to revisit it: a browser-side
  expiry would have to be rewritten on every response to keep step with the row, and any
  response that failed to would drop a live session's cookie — which arrives at the gate as
  `session-missing`, the exact answer ADR-0032 exists to prevent.
- **`session-expired` keeps its meaning.** What changed is *when* a session expires, never what
  a Merchant is told about it. The distinction from `session-missing` is what lets the Admin
  render a sign-in prompt rather than an empty page, and it is asserted for the idle path as it
  was for the absolute one.
- **Signing out is untouched and still immediate.** Extension is an `UPDATE` of a row that
  exists; it can never recreate one. A sign-out request extends the session on its way through
  the gate and then deletes it, and there is a test whose whole subject is that ordering.

## Thirty minutes, and why the cap is not optional

Thirty minutes is OWASP's range for an application of this sensitivity, and under a sliding
window its cost is far lower than it sounds: it is only ever met by a session nobody is using.
A Merchant at work never sees it. That is the whole trade a sliding window buys — the window
can be *shorter* than an absolute one and still be less disruptive, because it is measured
against the thing that actually indicates an unattended browser.

The cap is the answer to the obvious objection: **a session that activity extends is a session
that never ends.** The idle window protects against abandonment. It does nothing against
theft — a token lifted from a browser is worth an indefinite stay as long as the thief keeps
using it, and the legitimate Merchant's own traffic is what keeps it alive. So the cap bounds
what a stolen token buys and puts a floor under how often credentials are proved again.

Twelve hours is #4's original lifetime, kept in a new job: the number that used to be the whole
rule is now the ceiling over it. That is deliberate rather than sentimental — **no deployment's
sessions live longer than they did before this changed**, so this is not a decision anyone has
to re-argue as a loosening. It is anchored on `core_session.created_at`, a column that was
already there, so the cap costs no migration and no new state.

Both are enforced when a session is *read*, as the earlier of the two deadlines, rather than by
trusting whoever last wrote the row to have clamped it. Under ADR-0004 Core is not the only
writer this database has, and a rule enforced only on the write path is one a hand-run `UPDATE`
can lift.

## The write pattern

The naive sliding window writes on every request, which turns a read path into a write path and
puts an `UPDATE` behind every page the Admin renders. The ticket asks explicitly what was done
about it.

**A request extends the session only once the stored deadline has fallen a minute behind.** So
a session costs at most one `UPDATE` a minute however many requests it makes, and the busier the
session the cheaper each request is. It is one condition on the read path — no cache, no
background sweeper, no second store, nothing that can be out of step with the database, because
the database is still the only thing that knows when a session ends.

The precision this spends is stated rather than hidden: the deadline a Merchant actually gets
lands somewhere in `[29 minutes, 30 minutes]`, so **the guarantee is that 29 minutes of
inactivity always survive and 30 never do.** A minute against thirty is the knob at 1/30th;
larger buys fewer writes and spends the window, smaller buys precision nobody can perceive.

The same condition retires the write near the cap: once the clamp stops the deadline moving,
there is nothing far enough ahead to write, and the last half-hour of a capped session is free.

The `UPDATE` carries `expires_at > now()` in its `WHERE`, so an extension cannot resurrect a
session that lapsed between the read and the write, and it matches nothing at all if a
concurrent sign-out has already deleted the row. **Expiry is not reversible and sign-out
always wins.**

## `core_session` has no `updated_at`, and gains none

It is the one Core table without the column, and therefore the one table ADR-0037's schema
sweep does not attach a trigger to. That was true before this change and it stays true — but
it stops being true by accident, so it is worth recording, because this is the change that made
`core_session` a table Core actually updates.

Adding the column would record a fact `expires_at` already carries: a session is written for
exactly one reason, that it was used, and the stored deadline *is* the last request plus the
idle window. The second copy would cost a trigger firing on every extension to keep it in step
with the first. `updated-at.test.ts` asks its question of tables carrying the column, so nothing
here is being worked around: there is no column, and there should not be one.

## What was not decided

**Configurability.** #4's author flagged "not sliding" and "not configurable" together; the
maintainer ruled only on sliding, and this ADR takes the other half no further. The window
stays hardcoded because building it never made a knob awkward to do without: the three constants
sit in one module, a test reads them rather than restating them, and the OpenAPI description
interpolates them so it cannot go stale about them. **A configurable window is a different
decision with its own cost** — it has to be validated (an idle window longer than the cap is
nonsense), it has to reach the Admin, and it becomes a thing a Project can get wrong. Nobody
has asked for it. The trigger to revisit is a deployment that actually needs a different
number, not the general observation that some deployment might.

**Extending on a schedule rather than on a request.** A background job that swept deadlines
forward would decouple the write from the request entirely, and it would also be a second
mechanism that can be down while the gate is up. One condition on the read path needs nothing
to be running.
