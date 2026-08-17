# The idle window is a Project's, the absolute cap is Core's

A Project sets how long its Merchant sessions survive with nobody using them, in
`kobai.config.ts`, as `session.idleWindowMs`. It does **not** set the twelve-hour absolute cap,
and a window Core cannot serve stops the boot rather than being clamped to fit. A Project that
says nothing gets ADR-0045's numbers exactly: thirty minutes idle, twelve hours absolute.

[ADR-0045](./0045-sessions-expire-on-inactivity-under-an-absolute-cap.md) made the window slide
and left it hardcoded, recording that a knob "has to be validated, has to reach the Admin, and
becomes a thing a Project can get wrong", and that the trigger to revisit was "a deployment
that actually needs a different number". The maintainer has ruled that it is. Thirty minutes
came from OWASP's range for an application of this sensitivity; it is defensible and it is not
the only defensible answer, and a deployment with a different risk profile has had no way to
say so — a Merchant reading a long page for thirty-five minutes was signed out.

## What is decided

- **`session` is a key in `kobai.config.ts`, holding `idleWindowMs`.** Nested rather than a
  top-level `sessionIdleWindowMs`, because every key in that file names a *subject* a Project
  customised — its migration sets, its Workflows — and a bare number would be the first that
  is not, spelling the grouping into its own name. The next thing a deployment needs to say
  about its sessions goes beside it instead of forcing the shape after the fact, and a config
  file whose shape gets reorganised is one every Project has to rewrite (ADR-0001).
- **The absolute cap is not configurable.** See below.
- **A window outside `[2 minutes, 12 hours]`, or one that is not a whole number of
  milliseconds, throws from `createKobai`** — before a connection pool or a route exists, with
  a message naming `session.idleWindowMs`, the value it was given and the bound it missed.
  **Nothing is clamped.** A deployment whose sessions quietly last something other than what
  its config file says is a bug discovered by a Merchant rather than by the Developer who
  wrote it.
- **The write pattern is unchanged, and so is the shape of what it guarantees.** A request
  writes only once the stored deadline has fallen a minute behind. The guarantee ADR-0045
  stated as "twenty-nine minutes of inactivity always survive and thirty never do" becomes
  **"the configured window less one minute always survives, and the whole window never does —
  until the cap intervenes, which it does for nothing the window says"** — which at the
  default window is the same sentence with the same numbers in it. The caveat is not new;
  ADR-0045 carried it as "the same condition retires the write near the cap". It is stated
  because a *long* configured window makes it routine rather than a last-half-hour edge: the
  two deadlines are enforced as the earlier of the pair, so the longer the window the less of
  it a session ever sees. See below for the end of that line.
- **The deadline still slides both ways.** A stored deadline further out than a whole idle
  window is pulled *in* on first use. That was ADR-0045's answer to sessions minted under #4's
  flat twelve hours; under a configurable window it is also the answer to **lowering** one. A
  deployment that cuts thirty minutes to five finds a table full of deadlines up to
  twenty-five minutes past where its new window puts them, and an extension that only pushed
  forward would leave every one of them to run out the old window — the new setting taking
  effect for nobody who was already signed in.
- **The published description reports the numbers this deployment enforces.** `Session` is
  built per instance from the policy (`contract.sessionSchema`), so the two routes that answer
  with one are declared when the app is. A description that still said thirty minutes to a
  deployment serving forty-five would be worse than the hardcoded window it replaced: a wrong
  number is worse than an unconfigurable one.
- **Nothing else about a session moves.** `session-expired` stays distinguishable from
  `session-missing` (ADR-0045), the cookie still carries no `Expires` or `Max-Age` (ADR-0032)
  so the `core_session` row stays the single authority on lifetime, and both deadlines are
  still enforced when a session is *read*.

## Why the cap stays Core's

ADR-0045's argument for the cap is that **an idle window protects against abandonment and
nothing against theft** — a token lifted from a browser is worth an indefinite stay while the
thief keeps using it, and the legitimate Merchant's own traffic is what keeps it alive. The cap
is the only bound left once the window is being renewed by somebody's activity, and it is the
one number in this pair with nothing above it: a window that is too long is still swept up by
the cap, and a cap that is too long is swept up by nothing.

Applying ADR-0045's own trigger consistently is the other half. The window becomes configurable
because a deployment asked for a different number; **nobody has asked to live past twelve
hours**, and "some deployment might" is the reasoning that ADR explicitly declined to act on.

The direction matters too, and only one of them is being refused. **Raising** the cap is what
the theft argument forbids. **Lowering** it — a deployment that wants no session older than two
hours whatever happens — is a coherent thing to want, is strictly safer than what ships today,
and is the shape this decision would take if it is revisited: a cap a Project may bring down
and not up. It is not built now because the same trigger applies to it, and because a bound a
Project can only tighten is a second rule to explain for a need nobody has stated. A shorter
idle window is not a substitute for it and this ADR does not pretend otherwise: an idle window
of two hours bounds nothing for a Merchant who keeps clicking.

Keeping the cap fixed also keeps the validation honest. "The idle window may not exceed the
cap" is a bound against a constant a Developer can read in one place, rather than a relation
between two numbers in the same file that can be got wrong in two directions at once.

## Validation is at boot, and deliberately not at compile time

The ticket asked for compile time if it could be had. It cannot, and the reason is worth
recording rather than rediscovering: **TypeScript folds no arithmetic.** `45 * 60 * 1000` has
type `number`, not `2700000`, so a type-level bound would be defeated by the way Core's own
constants are written and by the way every Developer will write theirs. Expressing the window
in bare minutes would recover a literal type for two of the three cases and still not for
"longer than the cap", which needs type-level numeric comparison over eight digits.

That leaves two checks answering the same question differently, and a compile-time guarantee
that lapses the moment the number comes from an environment variable — which is precisely the
case a knob exists for. So there is one authority, at boot, before anything is opened.

**It throws where a failed migration returns an outcome** (#2). A migration fails for reasons a
running deployment can meet, so it has to be reportable on `/health` and the Project decides
what to do about it. This is a value in a file a Developer just wrote: wrong on every boot
until it is fixed, with nothing a caller could usefully do but stop. The distinguishable part
is the message — the key, the value, the bound — because "invalid configuration" is not a
diagnosis. A named error class would be a second promised export for a failure nobody can
handle.

**Two minutes is the floor, and it is arithmetic rather than taste.** The write pattern spends
up to a minute of the window on precision, so at the floor a window still guarantees half of
itself and every longer one guarantees more. At exactly one minute the guarantee is nothing: no
request would ever be stale enough to write, so the deadline a session was minted with would
also be its last and a Merchant clicking steadily would be signed out mid-sentence. That is not
a shorter window, it is a broken one.

**The ceiling is the cap, inclusive, and a window set there turns the knob off.** At exactly
twelve hours every deadline is pinned at sign-in plus twelve hours from the moment a session is
minted: the extension computes the same instant it already stored, so no `UPDATE` is ever
issued and the deployment has **no idle expiry at all** — only the cap. That is arithmetic
rather than a trap, and it is what a Project asking for a twelve-hour idle window has asked
for; it is also true to within a rounding error of any window near the cap, so refusing the
exact value would buy nothing but a different surprise one millisecond lower. It is therefore
documented — on the config key, on the constant and here — rather than forbidden, and there is
a test whose whole subject is that this configuration leaves the cap doing all the work.

**The extension interval stays a fixed minute rather than a fraction of the window.** Deriving
it — a thirtieth, which is what a minute is against thirty minutes — would keep the precision
proportional and spend the property the pattern exists for: a five-minute window would buy six
times the writes, and "at most one `UPDATE` a minute per session" is the sentence an operator
cares about. It stays absolute; the floor is what keeps the precision it spends from ever being
most of the window.

## The Admin still does not know, and still must not poll

ADR-0045 records that the idle window's honesty depends on the Admin making no request on a
timer, and **a configurable window does not change that** — a background poll would keep an
unattended browser signed in to the cap whatever the window is set to, and Core cannot tell
that request from a click. A Project setting a *short* window has a real case for the Admin
warning before the window lapses, and that is a separate ticket rather than something this one
should have smuggled in.

Two things are worth writing down for whoever takes it. The Admin already has everything it
needs: `expiresAt` comes back on **every** admin response and moves as the session slides, so a
warning is an Admin-side change and needs no new endpoint and no new field. And the moment such
a warning exists there will be pressure to add a "keep me signed in" button, which is a request
on a timer wearing a different hat — it is exactly the poll ADR-0045 says would erase the
window, and it needs the decision that ADR asks for rather than an implementation.

## Consequences

- **`kobai.config.ts` has three keys**, and the third is the first that can fail. A Project's
  boot can now stop over a number in that file, which is the cost of the knob and is paid
  loudly on purpose.
- **`DEFAULT_SESSION_IDLE_WINDOW_MS` is the constant's new name.** It is a default now, not the
  rule, and a name that said otherwise would be the same staleness as a description that still
  says thirty minutes.
- **The two routes that answer with a `Session` are built when the app is**, because their
  declaration carries this deployment's numbers. Every other route on the surface is still a
  module-level constant, and a route added to `admin.ts` needs no thought about this unless it
  answers with a `Session`.
- **The reference Project configures nothing**, deliberately: it is the deployment that proves
  the defaults are still what a Project gets for free (ADR-0029). What a configured window does
  is asserted against a booted kobai in `packages/core/src/auth/auth.test.ts`.
- **`SessionOptions` is on the promised surface and the cap is not.** A Project that wants a
  longer cap has to come back and argue for it, which is the outcome this ADR wants.
