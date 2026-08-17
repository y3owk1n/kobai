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
 * One position in a Workflow: the **slot** the declaration named, and the Step filling it.
 *
 * The two are separate because they stop being the same thing the moment a Project replaces
 * a Step (ADR-0017): the slot is what the override map is keyed by and what stays stable
 * across the swap, while `step.name` is whatever the implementation calls itself. They agree
 * in Core's own declaration and part company in a Project that has overridden one.
 */
export type WorkflowStep = {
  readonly slot: string;
  readonly step: AnyStep;
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
   * declaring it again — {@link overrideSteps} is how, and the only way that exists.
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
 * What a Project may change about one Workflow.
 *
 * A record with one key today, and that is deliberate: `before`/`after` insertion is a
 * separate, weaker mechanism under ADR-0017 and belongs beside `steps` rather than mixed into
 * it, so a Developer reading a config can tell replacement from observation at a glance.
 */
export type WorkflowOverrides<W extends AnyWorkflow> = {
  /** Which Step fills which slot. A named slot is replaced; an unnamed one is inherited. */
  readonly steps?: StepOverrides<W>;
};

/**
 * The same Workflow with the named slots filled by other Steps — ADR-0017's replacement, and
 * the whole of what Core does with a Project's override map.
 *
 * It **rebuilds the declaration** rather than copying the object. `describe` and `run` close
 * over the array they were built with, so `{ ...workflow, steps: mine }` would report the new
 * list and execute the old one — a Workflow claiming a Project's Step ran while Core's
 * actually did, which is the exact lie the mechanism exists to disprove. Going through the
 * same constructor `build()` uses is what makes that unrepresentable rather than merely
 * discouraged.
 *
 * The original is untouched and still runs what it always did: a declaration is a value, and
 * overriding produces another one.
 *
 * Naming a slot the Workflow does not declare throws, at the moment the declaration is
 * rewired rather than at the request that would have been priced differently. The compiler
 * already rejects it for a config written as a literal; this catches the map built at
 * runtime, where the alternative is an override that silently does nothing.
 */
export function overrideSteps<In, Out, Shapes extends StepShapes>(
  workflow: Workflow<In, Out, Shapes>,
  overrides: StepOverrideMap<Shapes>,
): Workflow<In, Out, Shapes> {
  const slots = new Set(workflow.steps.map((entry) => entry.slot));
  const supplied = overrides as Readonly<Record<string, AnyStep | undefined>>;

  for (const slot of Object.keys(supplied)) {
    if (slots.has(slot)) continue;
    throw new Error(
      `The Workflow ${JSON.stringify(workflow.name)} has no Step ${JSON.stringify(slot)} to replace. It declares ${[...slots].map((declared) => JSON.stringify(declared)).join(", ")}.`,
    );
  }

  return createWorkflow<In, Out, Shapes>(
    workflow.name,
    workflow.steps.map((entry) => {
      const replacement = supplied[entry.slot];
      return replacement ? { slot: entry.slot, step: replacement } : entry;
    }),
  );
}

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
    step(step) {
      // The declaration is rebuilt rather than mutated, so a builder is never half a
      // Workflow and holding on to an earlier one keeps meaning what it meant.
      return builder(name, [...steps, { slot: step.name, step: step as AnyStep }]);
    },

    build: () => createWorkflow<In, Current, Shapes>(name, steps),
  };
}

/**
 * The one place a Workflow object is made, from `build()` and from {@link overrideSteps}
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
