# A Step may invoke another Workflow, and the deployment's declaration is the one that runs

A Step may run another declared Workflow, through one exported function — `runWorkflow`. What
it resolves is not the declaration it was handed but **the deployment's version of it**, so a
Project that replaced an inner Step gets its own rule wherever that Workflow is reached from.
An inner Workflow's refusal comes back as a value the invoking Step decides about; a bug in an
inner Step travels as itself; and an inner Workflow that **completed** is unwound when a later
outer Step fails.

[ADR-0017](./0017-plugins-offer-steps-and-the-project-wires-them.md) declares Workflows and makes
their Steps replaceable, and says nothing at all about one Workflow reaching another. This is
the first case of it, and the shape it takes is a promise about the flagship Extension Point
rather than an implementation detail — which is why it is recorded before anything needs it.
The thing that will need it is the spine's `price-lines`, resolving each Line Item's price with
`resolve-price` so that story 45 — "my replaced pricing Step applies when an Order is placed" —
costs a Project nothing beyond the config line it already wrote.

## What is decided

- **`runWorkflow(workflow, input, context)` is the way, and it is on the promised surface.** A
  Plugin's Step and a Project's Step compose for the same reasons Core's do, so this is not a
  Core-internal helper. `workflow.run(input, context)` still works and is the quiet mistake it
  exists to prevent: it runs the declaration it was handed, which is Core's own whatever the
  deployment wired.
- **Resolution is by name, through a registry on the context.** `WorkflowContext` gains one
  optional key, `workflows` — every declaration this deployment runs, keyed by the name it
  answers to, published by `createKobai` as `Kobai.workflows`. A Step names Core's exported
  declaration because that is the only one it can import; the registry is how the rebuilt one
  is found from it.
- **An absent registry runs the declaration as given.** A Workflow assembled outside a
  deployment — in a test, in a script — has no registry behind it and must still run. Absent
  is a working answer, not a broken one.
- **An inner refusal is a value.** `runWorkflow` hands back the whole `WorkflowRun`, refusal
  included, naming the *inner* slot that stopped and the inner Steps that completed. Passing it
  on is `throw new StepFailure(run.reason, run.detail)`, after which the outer run refuses with
  the inner reason at the **outer** slot — the only position the outer declaration has a name
  for. Carrying on regardless is a legitimate choice, and one no runner could make on the
  invoking Step's behalf.
- **A bug in an inner Step travels as itself** (ADR-0036), out of the inner run, out of
  `runWorkflow`, out of the invoking Step, unchanged. A boundary is not a place a bug becomes a
  decision.
- **An inner Workflow that completed is unwound by the run around it.** The Steps a nested run
  completed are handed up when it succeeds, and unwound as part of the outer run's own
  unwinding — newest first, each Step handed the value its `run` was given and the context it
  ran against.
- **Order at the boundary is decided by the nesting, not by the clock.** The invoking Step's
  own compensation runs **first**, then the Workflows it invoked unwind in reverse. A Step sits
  outside what it called.
- **A Step that fails after invoking a Workflow still has that Workflow unwound.** It never
  completed, so it has no compensation of its own to run — and the work it had already
  delegated is precisely the kind that would otherwise be reached by nothing.
- **A compensation is handed the context its own run was given**, not the context of whoever is
  unwinding. Composition is what makes those two different things: an entry is routinely
  undone by a run that is not the one it was made in, and `metadata` — ADR-0013's open half —
  is the one part of a context a Step is entitled to expect back the way it arrived.

## Why the registry rather than injection

The obvious alternative is to hand the inner Workflow to the outer Step as a dependency —
`priceLines(resolvePriceWorkflow)`, wired once at boot with the rebuilt declaration. It is less
machinery and it works, for Core.

It fails for everybody else, and quietly. A Plugin author writing a Step that resolves a price
imports `priceResolutionWorkflow` from `@kobai/core`, because that is the only handle the
package offers — and gets Core's `select-price` on a deployment that replaced it. Nothing
raises, nothing logs, and the symptom is a price that is right in one caller and wrong in
another. ADR-0013's standing rule says a Project that cannot do something without reaching
outside the surface is evidence the surface is wrong; a Plugin that has *no way at all* to
reach the deployment's own declaration is the same evidence one step earlier.

The registry costs one optional key on a type Core already hands every Step, and it makes the
right thing the reachable one. **The honest weakness is that it is keyed by a string and holds
`AnyWorkflow`**, so a registry that put some other Workflow under a name is a lie no compiler
here can see, and `runWorkflow` casts across it. The registry a *deployment* runs on is built
by `createKobai` from Core's own declarations and is honest by construction; `WorkflowContext`
is nonetheless a public type and anyone assembling a context by hand — a test, a script — can
put anything in it, and gets what they asked for. That is a containment rather than a proof.
Making the key carry the declaration's type is the fix, and the moment to reach for it is when
a Project is given a say in what a *deployment's* registry holds.

## Why unwinding is the runner's job and not the Step's

The alternative was `runWorkflow` handing back an `undo` thunk for the invoking Step to store
and call from its own compensation. It is more explicit, and it creates exactly the class of
bug ADR-0036 exists to close: a Step that forgot to keep the thunk leaves an inner Workflow's
completed work with nothing that could ever undo it, and the failure is invisible until the day
something upstream fails — with money moved and stock claimed, which is the case the spine puts
under this mechanism.

So the runner threads a per-Step channel down the context and an inner run hands what it
completed to whatever context it was given. That closes the failure for the **direct** call as
well: a Step that reaches for `workflow.run(input, context)` instead of `runWorkflow` loses the
deployment's declaration and keeps the unwinding. The half that must never be got wrong needs
no cooperation; the half that is merely wrong is the one left to a function call.

The channel is symbol-keyed rather than a field on `WorkflowContext`, because it is the
runner's bookkeeping: a Step neither reads it nor sets it, and a field would be a promise about
it under ADR-0019. A symbol also survives the one thing a Step legitimately does to a context —
spreading it to add something — where a `WeakMap` keyed on the object would silently not.

The channel is *not* stripped off the context a compensation is handed, and the first draft of
this did strip it. The argument for stripping was that a compensation which invoked a Workflow
would register that Workflow's own compensations against an unwinding already in progress. The
argument against it is that stripping changes nothing observable — the unwinding has taken its
list by the time any compensation runs, so an entry arriving late is dropped either way — which
made it a promise this ADR stated and no test could ever fail on. ADR-0049's rule applies to a
guard as much as to a migration: an effect no test asserts is the gap.

## What is deliberately not promised

- **Core does not merge an inner run's `uncompensated` into the outer run's.** An inner
  Workflow that refused has already unwound its own Steps, and the compensations that threw
  while it did are reported on the `WorkflowRun` handed to the invoking Step. Merging them into
  the outer run's list would put entries from a finished unwinding into a list documented as
  *this* run's, "in the order they were attempted" — an order neither run could explain. The
  invoking Step has both facts in hand and is where the decision belongs. This is the one place
  ADR-0036's second fact can be dropped by somebody other than Core, and it is written down
  rather than solved because solving it means either widening `StepFailure` or putting an
  unwinding report on a run that succeeded.
- **A successful outer run reports nothing about the Workflows its Steps invoked.** `steps`
  names the positions the outer declaration declares, and an inner Step fills none of them. A
  run's account of itself has to keep meaning "the Steps this declaration declares", or
  `describe()` and `run` stop answering the same question.
- **Nothing stops a Workflow invoking itself**, and through the registry it resolves to the
  deployment's version, which contains the same Step, which invokes it again. That is a
  declaration a Developer wrote, not a mechanism Core can rescue; there is no depth limit and
  no cycle detection, because either would be an arbitrary number in the middle of the flagship
  Extension Point.

## Consequences

- **`Kobai` publishes `workflows`.** A Developer can read what their deployment actually runs,
  which is the question `describe()` answers for one Workflow, and whatever builds a context
  for a request fills the context's `workflows` from it.
- **A route whose Step composes has to pass the registry.** Core's store surface builds its
  context as `{ db, metadata }` and carries no registry today, because the only Workflow that
  exists is the one being run. The first route that composes — `place-order` — passes
  `Kobai.workflows` when it builds its context, and a route that forgets gets Core's Steps
  rather than the Project's.
- **`WorkflowContext` grew a key, and it had to be optional.** It is promised surface under
  ADR-0019 and a required field would have broken every hand-built context, Core's own test
  harness included, for a capability most Steps never use.
- **Compensation now carries its context per entry.** An entry is routinely unwound by a run
  that is not the one it was made in, so taking the context from whoever is unwinding would
  hand a compensation somebody else's `metadata` — ADR-0013's open half, and the one part of a
  context a Step is entitled to expect back the way it arrived.
