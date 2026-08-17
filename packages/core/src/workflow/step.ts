import type { Database } from "../db/client.ts";

/**
 * A **Step** — one named, typed unit inside a Workflow, individually replaceable by a Plugin
 * or a Project (`CONTEXT.md`). Replacing one is kobai's flagship customisation mechanism
 * (ADR-0003).
 *
 * A Step is a function with a name and two declared types: what it takes and what it gives
 * back. That is the whole interface, and the types are the point rather than decoration —
 * ADR-0017 requires a replacement to *satisfy the original Step's input and output types*,
 * checked by the compiler, and a Step that did not declare them would leave nothing to check.
 */

/**
 * What a Step runs against — the Workflow's context, and it is **open** (ADR-0013).
 *
 * `metadata` is the openness. Core writes into it and never reads from it: whatever the
 * caller sent that Core does not model arrives here verbatim, so a Project's Step can read
 * data Core has never heard of. ADR-0013 is explicit that this cannot be a closed typed
 * struct — if it were, lead-time pricing would be impossible without changing Core, and the
 * flagship mechanism would fail its first real test. The cost is type safety at this one
 * boundary, paid deliberately.
 */
export type WorkflowContext = {
  readonly db: Database;
  /** Untyped by design. Core never reads a key out of this. */
  readonly metadata: Readonly<Record<string, unknown>>;
};

/**
 * One Step: a name, and a typed function from `In` to `Out`.
 *
 * `run` is a **property** holding a function rather than a method, and the difference is
 * load-bearing. TypeScript checks method parameters bivariantly and function-property
 * parameters contravariantly, so only this spelling makes a replacement that accepts a
 * *narrower* input a compile error rather than a runtime surprise — which is exactly the
 * check ADR-0017 promises.
 */
export type Step<Name extends string, In, Out> = {
  readonly name: Name;
  readonly run: (input: In, context: WorkflowContext) => Out | Promise<Out>;
};

/**
 * Any Step at all, for the places that hold a list of them and cannot know their shapes.
 *
 * `never` in and `unknown` out is the widest supertype the variance allows: every
 * `Step<Name, In, Out>` is assignable to it, and nothing can be *called* through it without a
 * cast — which is correct, because only the Workflow that declared the order knows what is
 * safe to pass.
 */
export type AnyStep = Step<string, never, unknown>;

/**
 * Declares a Step.
 *
 * The name is a literal type, not merely a string, so the Workflow it goes into knows which
 * slot it fills at compile time as well as at runtime.
 *
 * ```ts
 * const selectPrice = defineStep("select-price", (loaded: LoadedPrices): ResolvedPrice => …);
 * ```
 *
 * The return type is `Awaited<R>` rather than an inferred `Out | Promise<Out>`: given an
 * `async` function, that union leaves TypeScript two equally good candidates — `Out = X` and
 * `Out = Promise<X>` — and which one it picks is not something a public interface should
 * depend on.
 */
export function defineStep<Name extends string, In, R>(
  name: Name,
  run: (input: In, context: WorkflowContext) => R,
): Step<Name, In, Awaited<R>> {
  return { name, run: run as Step<Name, In, Awaited<R>>["run"] };
}

/**
 * A Step refusing: the Workflow cannot produce its output, and that is an answer rather than
 * a fault.
 *
 * Thrown rather than returned, so a Step's declared output type stays the type of its
 * *success* and the chain of `In → Out` reads as the process actually does. The runner
 * catches this and nothing else — an ordinary `Error` is a bug and keeps travelling, so a
 * broken Step surfaces as a 500 rather than being reported as a refusal the caller could act
 * on.
 *
 * `reason` is machine-readable and `detail` is for a person, matching every other refusal
 * kobai makes.
 */
export class StepFailure extends Error {
  readonly reason: string;
  readonly detail: string;

  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "StepFailure";
    this.reason = reason;
    this.detail = detail;
  }
}
