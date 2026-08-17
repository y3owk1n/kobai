# Unwinding is exhaustive, and a compensation that fails never replaces what stopped the run

When a Step fails, Core unwinds the Steps that completed — newest first, each handed the very
value its `run` was given (ADR-0017). This record fixes the edge ADR-0017 left unstated: what
happens when one of those compensations throws.

**Two promises, and they hold together:**

1. **Every completed Step's compensation is attempted.** A compensation that throws is caught
   and recorded; the unwinding carries on to the Steps before it, in the same reverse order it
   would have used anyway.
2. **What stopped the run is what the caller is told.** A refusal is still reported as that
   refusal, with its `reason` and `detail` intact, so a Workflow that declined a request with
   a 422 still answers 422. A bug in a Step still travels as a bug and still surfaces as a
   500. Neither is replaced by a compensation failing.

The compensations that threw are reported *beside* the outcome, never in place of it: on a
refusal they are the `uncompensated` list on the `WorkflowRun`; on a bug — a throw, which has
no result object to carry a second fact — the bug becomes the `cause` of an `UnwindFailure`,
an `AggregateError` whose `errors` are the compensations that threw and whose message names
the slots left uncompensated.

## What a Plugin author may rely on

- Core calls the compensation of **every** Step that completed, in the reverse of the order
  they ran, and hands each one the identical value (`===`) its `run` was given.
- **A compensation that throws is contained.** It does not stop the compensations of the Steps
  before it, and it does not decide what the caller is told. It is caught, recorded against
  the slot it belongs to, and reported.
- **Order is unaffected by failure.** Reverse order holds across a failing compensation, so
  bookkeeping keyed on it — the `WeakMap` from a resolved Price to the rows it wrote in
  `@kobai/plugin-price-log`, for example — stays correct whether or not a neighbouring
  compensation worked.
- A compensation is therefore **not** a place to signal a decision. Throwing from one changes
  nothing about the answer; it only records that this Step could not be undone.

## Why continue rather than stop

#8 shipped the opposite — the first failing compensation stopped the unwinding and travelled
in place of the refusal — deliberately, and pinned it with a test: continuing over "a machine
that has just proved it does not understand its own state" looked like the cautious choice.
Two things make it the wrong one.

A compensation is by nature the code most likely to be running against a system already in a
bad state, so one failing is the ordinary case rather than the remote one. And stopping there
leaves the Steps *earlier* in the chain uncompensated — the exact situation compensation
exists to prevent, reached by the mechanism meant to prevent it. Spec story 31 asks for
unwinding that is *predictable*; under the old rule what had and had not been undone depended
on where in the chain the failure landed, which is the opposite. One Step that cannot be
undone is a smaller mess than one Step that cannot be undone plus every Step before it that
nobody tried.

The cost is that a compensation may now run after an earlier one failed, on a system whose
state is in doubt. That is accepted: each compensation is handed only the value its own Step
ran on, so they are independent by construction, and the one ordering dependency between them
— later work resting on earlier work — is already what the reverse order is for.

## Why the refusal survives, and where the other fact goes

They answer different questions. The refusal answers *why was this rejected*; the compensation
failure answers *is the Store now consistent*. Under the old rule the second erased the first,
so a legitimate refusal was reported as a server error and the caller lost the reason they
were actually refused for — a fact only the Workflow knew, and one no amount of retrying
recovers.

So the refusal goes in the response body, unchanged, and the compensation failure does not.
A storefront cannot act on it; an operator must. It is reported on the run and on the thrown
error, and Core's HTTP boundary logs an error's `message` — which is why `UnwindFailure`'s
message carries **both** facts, the Steps left uncompensated and what stopped the run. A
wrapper that kept the original only in `cause` would make a broken Step quieter in the log
than it was before it also broke its own cleanup.

What is **not** done here: on the refusal path nothing logs `uncompensated`, because a refusal
is a value the store surface turns into a response and that surface is not this record's to
change. Surfacing it in a log line there is the remaining half. It deliberately does not
change the response *shape* either way — the body a storefront parses should not grow a field
about the Store's internal consistency, because a storefront can do nothing with it and the
Merchant it concerns is not the one reading it.

## Consequences

- `WorkflowRun`'s failed variant carries `uncompensated`, always present and usually empty.
  Empty is a fact worth having: it says the Store was left as the Workflow found it.
- `UnwindFailure` is part of Core's promised surface (ADR-0019), so a Project that wraps a
  Workflow's `run` can tell "a Step is broken" from "a Step is broken and the cleanup after it
  is too".
- A Step's compensation should still not throw. This makes one that does survivable; it does
  not make it acceptable, and there is no retry — Core attempts each compensation exactly
  once.
