import type { WorkflowContext } from "./context.ts";
import { runSteps, type WorkflowRun } from "./run.ts";
import type { AnyStep, Step } from "./step.ts";

/**
 * A **Workflow** — a named, declared commerce process composed of ordered Steps
 * (`CONTEXT.md`).
 *
 * A Workflow is a *declaration* first and a thing that runs second. That order matters:
 * ADR-0003 promises a Developer can see what the system does before changing it, so the
 * object below can be read — `describe()` names every Step in order — without opening Core.
 *
 * It is built one Step at a time, and the builder carries the type of what the last Step
 * produced. Declaring a Step whose input does not match is a compile error at the point of
 * declaration, which is what makes "the runner executes the Steps in declared order" safe to
 * implement with a single cast rather than with runtime checks nobody can act on.
 *
 * ```ts
 * const workflow = defineWorkflow<Request>("resolve-price")
 *   .step(loadPrices)   // Request      → LoadedPrices
 *   .step(selectPrice)  // LoadedPrices → ResolvedPrice
 *   .build();
 * ```
 */

/** The declared input and output of one Step, as the compiler sees it. */
export type StepShape = { readonly input: unknown; readonly output: unknown };

/** Every Step's shape, keyed by the slot it fills. */
export type StepShapes = { readonly [slot: string]: StepShape };

/** A Workflow that has no Steps yet — the shape map a builder starts from. */
export type NoStepShapes = Readonly<Record<never, never>>;

/**
 * Where the Step in a position came from: Core's own declaration, a Project's replacement, or
 * a Project's insertion (ADR-0080).
 *
 * **Recorded, never inferred.** The obvious inference is `slot === step.name`, and it is wrong
 * in both directions: an inserted Step occupies a position under its own name, so it reads as
 * stock; and a replacement is free to answer to the slot's own name, so it reads as stock too.
 * Both mistakes are confident and silent, and both land on the flagship Extension Point
 * (ADR-0003). {@link rewireWorkflow} is the one place that holds both the stock declaration and
 * the result, so the answer is known there for free and written down there.
 */
export const STEP_ORIGINS = ["stock", "replaced", "inserted"] as const;

/** {@link STEP_ORIGINS}, as a type. */
export type StepOrigin = (typeof STEP_ORIGINS)[number];

/**
 * A **slot's own postcondition** — checked on whatever fills it, after the Step has answered.
 *
 * The types are what a slot promises and they cannot express everything one does. A Step
 * declaring a *narrower* input is still assignable — TypeScript accepts a function that asks for
 * less than it is handed — so a Step written against an older shape of the input compiles, reads
 * none of what it never heard of, and drops it out of what it returns. That is silent by
 * construction: the value is well typed, nothing refuses, and the loss surfaces as a wrong
 * number rather than as a failure. `place-order`'s `apply-adjustments` and `calculate-tax` are
 * the worked examples (#339) — one guard, declared at both positions — and it is where the
 * argument is written.
 *
 * Three things about what belongs here:
 *
 * - **It is the *slot's*, not the Step's**, which is the whole point: {@link rewireWorkflow}
 *   carries it onto a replacement, so a Project cannot supply one, remove one or replace one
 *   away. A check a Step could take out with it would be a check that holds only while nobody
 *   has customised anything, which is the guarantee #339 found and rejected.
 * - **It reads values and does nothing else.** No database, no clock, no bookkeeping: it is
 *   asked on the way past on every run, including a quote (ADR-0077), and a guard with an effect
 *   would be a Step nobody declared.
 * - **It throws or it says nothing**, and what it throws is an ordinary `Error` rather than a
 *   `StepFailure`. A guard fires when this *deployment* is wired wrongly, which is a bug and
 *   travels as one — a refusal would tell a storefront its purchase was declined.
 */
export type SlotGuard<In, Out> = (input: In, output: Out) => void;

/** Any slot guard at all, for the positions that hold one and cannot know their shapes. */
export type AnySlotGuard = SlotGuard<never, never>;

/**
 * One position in a Workflow: the **slot** the declaration named, the Step filling it, where
 * that Step came from, and whatever the slot asks of what comes out of it.
 *
 * The first two are separate because they stop being the same thing the moment a Project
 * replaces a Step (ADR-0017): the slot is what the override map is keyed by and what stays
 * stable across the swap, while `step.name` is whatever the implementation calls itself. They
 * agree in Core's own declaration and part company in a Project that has overridden one.
 *
 * `origin` is the third because the first two cannot answer for it — see {@link StepOrigin}.
 */
export type WorkflowStep = {
  readonly slot: string;
  readonly step: AnyStep;
  readonly origin: StepOrigin;
  /**
   * What this slot asks of what filled it, beyond the types — see {@link SlotGuard}.
   *
   * Absent on almost every position, and absent on every **inserted** one: an inserted Step
   * occupies a position of its own and fills no slot, so there is no slot's promise for it to
   * be held to.
   */
  readonly guard?: AnySlotGuard;
};

/**
 * One Step, as a Developer inspecting the declaration sees it.
 *
 * `slot` rather than `name`, and deliberately the same word `WorkflowStep` and
 * {@link StepReport} use: what a description names is the *position*, which is what stays
 * put when a Project swaps the implementation filling it.
 */
export type StepDescriptor = { readonly slot: string };

/**
 * A Workflow as plain data — what it is called and what it is made of, in order.
 *
 * Serialisable on purpose: this is the answer to "what does this Workflow do", and it should
 * be as easy to log or serve as it is to read in a debugger.
 */
export type WorkflowDescription = {
  readonly name: string;
  readonly steps: readonly StepDescriptor[];
};

export type Workflow<In, Out, Shapes extends StepShapes = StepShapes> = {
  readonly name: string;
  /**
   * Every position, in declared order.
   *
   * Read it; do not rebuild a Workflow by spreading one. `describe` and `run` close over
   * this array as it was when the Workflow was made, so `{ ...workflow, steps: mine }` would
   * answer with the new list and still *execute* the old one. Rewiring a Workflow means
   * declaring it again — {@link rewireWorkflow} is how, and the only way that exists.
   */
  readonly steps: readonly WorkflowStep[];
  /** What this Workflow is made of, without reading Core's implementation. */
  describe(): WorkflowDescription;
  /** Runs the declared Steps in order, through Core's runner. */
  run(input: In, context: WorkflowContext): Promise<WorkflowRun<Out>>;
  /**
   * The input and output type of each slot, **for the compiler only**. Nothing assigns it,
   * so reading it at runtime yields `undefined`; it is declared so that a replacement can be
   * checked against the Step it replaces (ADR-0017, spec story 27). Read it through
   * {@link StepInput} and {@link StepOutput} rather than directly.
   */
  readonly stepShapes?: Shapes;
};

/** Any Workflow at all — the supertype the helpers below match against. */
export type AnyWorkflow = Workflow<never, unknown, StepShapes>;

/** The slots a Workflow declares, as a union of string literals. */
export type WorkflowSlots<W extends AnyWorkflow> =
  W extends Workflow<never, unknown, infer Shapes> ? keyof Shapes & string : never;

/** What the Step in `Slot` is given. A replacement must accept it. */
export type StepInput<W extends AnyWorkflow, Slot extends WorkflowSlots<W>> =
  W extends Workflow<never, unknown, infer Shapes>
    ? Slot extends keyof Shapes
      ? Shapes[Slot]["input"]
      : never
    : never;

/** What the Step in `Slot` must produce. A replacement may not widen or narrow it. */
export type StepOutput<W extends AnyWorkflow, Slot extends WorkflowSlots<W>> =
  W extends Workflow<never, unknown, infer Shapes>
    ? Slot extends keyof Shapes
      ? Shapes[Slot]["output"]
      : never
    : never;

/**
 * The Steps a Project supplies for a Workflow's slots, keyed by slot.
 *
 * Every entry is optional — a Project names the one or two slots it disagrees with and
 * inherits the rest — and every entry's *types* are fixed by the slot it fills. The name is
 * free, because a replacement is a different Step and should be able to say so; the input and
 * output are not, because that is the whole of ADR-0017's "a replacement must satisfy the
 * original Step's input and output types". `Step`'s `run` is a function-valued property
 * rather than a method precisely so a replacement demanding a *narrower* input is rejected
 * here rather than handed `undefined` at runtime.
 *
 * Expressed over `Shapes` rather than over a Workflow type, so that this stays assignable in
 * both directions when a Workflow is matched against {@link AnyWorkflow}. A Project reads it
 * through {@link StepOverrides}.
 */
export type StepOverrideMap<Shapes extends StepShapes> = {
  readonly [Slot in keyof Shapes & string]?: Step<
    string,
    Shapes[Slot]["input"],
    Shapes[Slot]["output"]
  >;
};

/** {@link StepOverrideMap}, named against the Workflow being overridden rather than its shapes. */
export type StepOverrides<W extends AnyWorkflow> =
  W extends Workflow<never, unknown, infer Shapes> ? StepOverrideMap<Shapes> : never;

/**
 * A Step inserted at a position, rather than filling a slot: it is handed a value and hands
 * back **the same type**.
 *
 * That single pinned type is the whole of ADR-0017's "insertion cannot alter the output
 * contract", and it is deliberately weaker than replacement. A Step here may read what flows
 * past — log it, record it, measure it — and cannot change its shape, so observation cannot
 * quietly become mutation (spec story 29). No new mechanism enforces it: this is the same
 * check that rejects a bad replacement, with the input and the output pinned together.
 *
 * If insertion could change the output there would be no reason to ever replace a Step, and
 * the two mechanisms would collapse into one that is impossible to reason about.
 */
export type InsertedStep<Value> = Step<string, Value, Value>;

/**
 * The Steps a Project runs **before** each slot, keyed by slot.
 *
 * A list rather than one Step, because observing composes — a Project may want its own
 * measurement beside a Plugin's recording — and because the order they are written in is the
 * order they run in, and the reverse of the order their compensations unwind in. Replacement
 * is one Step per slot for the opposite reason: a slot holds exactly one implementation.
 *
 * Each Step is pinned to what the slot is *given*, since that is the value flowing at this
 * position.
 */
export type StepsBeforeMap<Shapes extends StepShapes> = {
  readonly [Slot in keyof Shapes & string]?: readonly InsertedStep<
    Shapes[Slot]["input"]
  >[];
};

/**
 * The Steps a Project runs **after** each slot, keyed by slot — pinned to what the slot
 * *produces*, since that is the value flowing here. See {@link StepsBeforeMap}.
 */
export type StepsAfterMap<Shapes extends StepShapes> = {
  readonly [Slot in keyof Shapes & string]?: readonly InsertedStep<
    Shapes[Slot]["output"]
  >[];
};

/** {@link StepsBeforeMap}, named against the Workflow rather than its shapes. */
export type StepsBefore<W extends AnyWorkflow> =
  W extends Workflow<never, unknown, infer Shapes> ? StepsBeforeMap<Shapes> : never;

/** {@link StepsAfterMap}, named against the Workflow rather than its shapes. */
export type StepsAfter<W extends AnyWorkflow> =
  W extends Workflow<never, unknown, infer Shapes> ? StepsAfterMap<Shapes> : never;

/**
 * What a Project may change about one Workflow, expressed over `Shapes` for the same reason
 * {@link StepOverrideMap} is. A Project reads it as {@link WorkflowOverrides}.
 *
 * Three keys, and the separation is the decision ADR-0017 records: `steps` replaces, and
 * `before`/`after` observe. They sit beside each other rather than mixed together so that a
 * Developer reading a config can tell owning a Step from watching one at a glance — and so
 * that the compiler can hold them to different promises, since only replacement is allowed to
 * decide what a slot produces.
 */
export type WorkflowOverrideMap<Shapes extends StepShapes> = {
  /** Which Step fills which slot. A named slot is replaced; an unnamed one is inherited. */
  readonly steps?: StepOverrideMap<Shapes>;
  /** Steps to run before a slot, watching what it is about to be given. */
  readonly before?: StepsBeforeMap<Shapes>;
  /** Steps to run after a slot, watching what it produced. */
  readonly after?: StepsAfterMap<Shapes>;
};

/** {@link WorkflowOverrideMap}, named against the Workflow being rewired. */
export type WorkflowOverrides<W extends AnyWorkflow> =
  W extends Workflow<never, unknown, infer Shapes> ? WorkflowOverrideMap<Shapes> : never;

/**
 * The same Workflow with a Project's config applied — slots refilled, Steps inserted around
 * them — and the whole of what Core does with what a Project declared (ADR-0017).
 *
 * It **rebuilds the declaration** rather than copying the object. `describe` and `run` close
 * over the array they were built with, so `{ ...workflow, steps: mine }` would report the new
 * list and execute the old one — a Workflow claiming a Project's Step ran while Core's
 * actually did, which is the exact lie the mechanism exists to disprove. Going through the
 * same constructor `build()` uses is what makes that unrepresentable rather than merely
 * discouraged.
 *
 * The original is untouched and still runs what it always did: a declaration is a value, and
 * rewiring produces another one.
 *
 * Naming a slot the Workflow does not declare throws, at the moment the declaration is
 * rewired rather than at the request that would have been priced differently. The compiler
 * already rejects it for a config written as a literal; this catches the map built at
 * runtime, where the alternative is an override that silently does nothing. So does an
 * inserted Step that answers to a name the Workflow already uses for a slot — see
 * {@link insertedAt}.
 */
export function rewireWorkflow<In, Out, Shapes extends StepShapes>(
  workflow: Workflow<In, Out, Shapes>,
  overrides: WorkflowOverrideMap<Shapes>,
): Workflow<In, Out, Shapes> {
  // The declaration's types are discharged here, as they are in the runner: the compiler has
  // already held every Step in these maps to the position it was written at.
  const slots = new Set(workflow.steps.map((entry) => entry.slot));
  const replacements = (overrides.steps ?? {}) as Replacements;
  const before = (overrides.before ?? {}) as Insertions;
  const after = (overrides.after ?? {}) as Insertions;

  for (const [map, verb] of [
    [replacements, "replace"],
    [before, "insert before"],
    [after, "insert after"],
  ] as const) {
    for (const slot of Object.keys(map)) {
      if (slots.has(slot)) continue;
      throw new Error(
        `The Workflow ${JSON.stringify(workflow.name)} has no Step ${JSON.stringify(slot)} to ${verb}. It declares ${[...slots].map((declared) => JSON.stringify(declared)).join(", ")}.`,
      );
    }
  }

  const rewired: WorkflowStep[] = [];
  for (const entry of workflow.steps) {
    // An inserted Step occupies a position of its own, under its own name: it fills no slot
    // Core declared, so it answers to itself and a slot stays what a Project's `steps` map is
    // keyed by. Insertion is anchored to the *slot*, not to what fills it, so a Project may
    // replace a Step and watch the same position in one config.
    for (const step of before[entry.slot] ?? [])
      rewired.push(insertedAt(workflow.name, step, slots));
    const replacement = replacements[entry.slot];
    // The `origin` is written here rather than derived later, and here is the only place it can
    // be: this line holds both what Core declared for the slot and what is going into it, and
    // one line down that difference is gone. `entry` is carried through unchanged when nothing
    // replaced it, so a slot a Project said nothing about keeps whatever it already was.
    //
    // **The replacement is the slot's entry with a different Step in it**, spread rather than
    // rebuilt from two of its three fields, because everything else about a position belongs to
    // the *slot* and has to survive the swap. `guard` is what makes that load-bearing rather
    // than tidy (#339): a check a Project could replace away holds only until somebody
    // customises the very slot it is about.
    rewired.push(
      replacement ? { ...entry, step: replacement, origin: "replaced" } : entry,
    );
    for (const step of after[entry.slot] ?? [])
      rewired.push(insertedAt(workflow.name, step, slots));
  }

  return createWorkflow<In, Out, Shapes>(workflow.name, rewired);
}

/** Puts one inserted Step in a position of its own, refusing a name a slot already answers to. */
function insertedAt(
  workflow: string,
  step: AnyStep,
  slots: ReadonlySet<string>,
): WorkflowStep {
  if (slots.has(step.name)) {
    throw new Error(
      `An inserted Step may not be called ${JSON.stringify(step.name)}: the Workflow ${JSON.stringify(workflow)} already declares a Step ${JSON.stringify(step.name)}, and a slot is what an override map is keyed by.`,
    );
  }
  return { slot: step.name, step, origin: "inserted" };
}

/** A replacement map with its declared types discharged: slot to the Step filling it. */
type Replacements = Readonly<Record<string, AnyStep | undefined>>;

/** An insertion map, likewise: slot to the Steps watching that position, in order. */
type Insertions = Readonly<Record<string, readonly AnyStep[] | undefined>>;

/**
 * Declares a Workflow, one Step at a time.
 *
 * `Current` is the type the Steps declared so far have arrived at, so the next Step is
 * checked against it. `Shapes` accumulates what each slot takes and gives back, which is the
 * record a Project's override is measured against.
 */
export type WorkflowBuilder<In, Current, Shapes extends StepShapes> = {
  step<Name extends string, Out>(
    step: Step<Name, Current, Out>,
    /**
     * What this slot asks of what fills it, beyond the types — see {@link SlotGuard}. Written
     * here rather than inside the Step because it belongs to the **position**: a replacement
     * inherits it, which is the only way a check about a slot can survive that slot being
     * replaced.
     */
    guard?: SlotGuard<Current, Out>,
  ): WorkflowBuilder<
    In,
    Out,
    Shapes & {
      readonly [Slot in Name]: { readonly input: Current; readonly output: Out };
    }
  >;
  /** Freezes the declaration. The result is data, plus the two ways of reading it. */
  build(): Workflow<In, Current, Shapes>;
};

export function defineWorkflow<In>(name: string): WorkflowBuilder<In, In, NoStepShapes> {
  return builder(name, []);
}

function builder<In, Current, Shapes extends StepShapes>(
  name: string,
  steps: readonly WorkflowStep[],
): WorkflowBuilder<In, Current, Shapes> {
  return {
    step(step, guard) {
      // The declaration is rebuilt rather than mutated, so a builder is never half a
      // Workflow and holding on to an earlier one keeps meaning what it meant.
      return builder(name, [
        ...steps,
        {
          slot: step.name,
          step: step as AnyStep,
          origin: "stock",
          // The declaration's types are discharged here, as they are everywhere else a Step's
          // shapes meet a list that cannot know them: the builder has already checked this
          // guard against what the slot is given and what it produces.
          guard: guard as AnySlotGuard | undefined,
        },
      ]);
    },

    build: () => createWorkflow<In, Current, Shapes>(name, steps),
  };
}

/**
 * The one place a Workflow object is made, from `build()` and from {@link rewireWorkflow}
 * alike.
 *
 * One constructor rather than two is what keeps the trap on `steps` closed: everything that
 * answers questions about a Workflow closes over the array passed in here, so there is no way
 * to produce one whose account of itself and whose behaviour disagree.
 */
function createWorkflow<In, Out, Shapes extends StepShapes>(
  name: string,
  steps: readonly WorkflowStep[],
): Workflow<In, Out, Shapes> {
  return {
    name,
    steps,
    describe: () => ({ name, steps: steps.map((entry) => ({ slot: entry.slot })) }),
    run: (input, context) => runSteps<Out>(steps, input, context),
  };
}
