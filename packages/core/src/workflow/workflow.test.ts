import { describe, expect, it } from "vitest";
import type { Database } from "../db/client.ts";
import {
  type PriceResolutionRequest,
  type PriceResolutionWorkflow,
  priceResolutionWorkflow,
  type ResolvedPrice,
} from "../pricing/resolve-price.ts";
import { createTestKobai, seedTestCatalog } from "../testing/index.ts";
import { openMetadata, openMetadataWithBody, type WorkflowContext } from "./context.ts";
import { runWorkflow, UnwindFailure } from "./run.ts";
import { defineStep, type Step, StepFailure } from "./step.ts";
import {
  defineWorkflow,
  rewireWorkflow,
  type StepInput,
  type StepOutput,
  type StepOverrides,
  type StepShapes,
  type StepsAfter,
  type StepsBefore,
  type Workflow,
  type WorkflowSlots,
} from "./workflow.ts";

/**
 * The Workflow surface, tested directly rather than through HTTP.
 *
 * That is the exception AGENTS.md's "the dominant seam is the public HTTP API" allows for,
 * and it is deliberate: a declared Workflow is one of ADR-0003's five Extension Points, so
 * the declaration *is* a public interface a Project imports and reads. "A Developer can
 * inspect the Workflow's declared Steps without reading Core's implementation" is a promise
 * about this object, and no HTTP response can carry it.
 */

/** No Step below touches the database, so there is nothing for a real handle to do. */
const CONTEXT: WorkflowContext = {
  db: undefined as unknown as Database,
  metadata: {},
};

/** A value that records the Steps that have touched it, in the order they did. */
type Trail = { readonly trail: readonly string[] };

const visit = <Name extends string>(name: Name) =>
  defineStep(name, (input: Trail): Trail => ({ trail: [...input.trail, name] }));

describe("declaring a Workflow", () => {
  it("reports the Steps it is made of, in declared order", () => {
    const workflow = defineWorkflow<{ readonly n: number }>("arithmetic")
      .step(defineStep("double", (input: { readonly n: number }) => ({ n: input.n * 2 })))
      .step(defineStep("stringify", (input: { readonly n: number }) => String(input.n)))
      .build();

    expect(workflow.describe()).toEqual({
      name: "arithmetic",
      steps: [{ slot: "double" }, { slot: "stringify" }],
    });
  });
});

describe("running a Workflow", () => {
  it("runs the Steps in declared order and answers with the last one's output", async () => {
    const workflow = defineWorkflow<Trail>("visits")
      .step(visit("first"))
      .step(visit("second"))
      .step(visit("third"))
      .build();

    const run = await workflow.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // Order proved by the value itself rather than by watching the runner work: each Step
    // appends its own name, so the output *is* the sequence they ran in.
    expect(run.output).toEqual({ trail: ["first", "second", "third"] });
  });

  it("reports which Steps ran, naming the slot and what filled it", async () => {
    const workflow = defineWorkflow<Trail>("visits")
      .step(visit("first"))
      .step(visit("second"))
      .build();

    const run = await workflow.run({ trail: [] }, CONTEXT);

    expect(run.steps).toEqual([
      { step: "first", implementation: "first" },
      { step: "second", implementation: "second" },
    ]);
  });

  it("stops at a refusing Step, naming it and the Steps that completed", async () => {
    const workflow = defineWorkflow<Trail>("visits")
      .step(visit("first"))
      .step(
        defineStep("refuses", (_input: Trail): Trail => {
          throw new StepFailure("nothing-doing", "This Step declines to proceed.");
        }),
      )
      .step(visit("never-reached"))
      .build();

    const run = await workflow.run({ trail: [] }, CONTEXT);

    expect(run).toEqual({
      ok: false,
      failed: "refuses",
      reason: "nothing-doing",
      detail: "This Step declines to proceed.",
      steps: [{ step: "first", implementation: "first" }],
      // Nothing was left half-undone: no Step here declared a compensation, so there was
      // nothing to unwind and nothing that could have failed at it (ADR-0036).
      uncompensated: [],
    });
  });

  it("lets an ordinary error travel, because a bug is not a refusal", async () => {
    const workflow = defineWorkflow<Trail>("visits")
      .step(
        defineStep("broken", (_input: Trail): Trail => {
          throw new TypeError("undefined is not a function");
        }),
      )
      .build();

    await expect(workflow.run({ trail: [] }, CONTEXT)).rejects.toThrow(
      "undefined is not a function",
    );
  });

  it("fills the open half of a context from what the caller sent", () => {
    // The edge ADR-0013 depends on: a Developer must be able to get their own input to
    // their own Step without adding a parameter to a Core route. Strings, not numbers —
    // parsing implies a shape, and Core has no opinion about the shape of what it does not
    // model.
    expect(
      openMetadata(new URL("http://kobai.test/store/variants/x/price?leadTimeDays=10")),
    ).toEqual({ leadTimeDays: "10" });

    expect(openMetadata(new URL("http://kobai.test/store/variants/x/price"))).toEqual({});
  });

  it("fills it from the body too, for a request that has one", () => {
    // The half a query string cannot carry (#121): a credential does not belong in a URL, and
    // a number is a number here rather than the digits of one.
    const url = new URL("http://kobai.test/store/orders?leadTimeDays=10");

    expect(
      openMetadataWithBody(url, { card_token: "tok_visa", tier: { name: "gold" } }),
    ).toEqual({
      ok: true,
      metadata: { leadTimeDays: "10", card_token: "tok_visa", tier: { name: "gold" } },
    });

    // No body half is not an empty one: the query string is the whole answer, exactly as it was
    // before there was another way in.
    expect(openMetadataWithBody(url, undefined)).toEqual({
      ok: true,
      metadata: { leadTimeDays: "10" },
    });
  });

  it("refuses a key that arrived in both halves rather than picking one", () => {
    // Neither body-wins nor query-wins: Core has never heard of the key, so choosing would be
    // Core forming an opinion about an input it does not model — and a Step reading the value
    // from the other place is the failure worth being loud about. Names, never values, so the
    // same request is refused however the two happen to compare.
    const refused = openMetadataWithBody(
      new URL("http://kobai.test/store/orders?leadTimeDays=10&card_token=tok_a"),
      { card_token: "tok_a", leadTimeDays: 10, gift: true },
    );

    expect(refused).toEqual({ ok: false, collided: ["card_token", "leadTimeDays"] });
  });

  it("carries inputs Core has never heard of to the Steps", async () => {
    // ADR-0013: the context is open, so a Project's Step can read data Core does not model.
    // Core writes `metadata` and never reads a key out of it — this Step does.
    const workflow = defineWorkflow<Trail>("visits")
      .step(
        defineStep(
          "reads-the-unmodelled",
          (input: Trail, context): Trail => ({
            trail: [...input.trail, String(context.metadata.leadTimeDays)],
          }),
        ),
      )
      .build();

    const run = await workflow.run(
      { trail: [] },
      { ...CONTEXT, metadata: { leadTimeDays: 10 } },
    );

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({ trail: ["10"] });
  });

  it("awaits a Step that answers asynchronously before running the next", async () => {
    const workflow = defineWorkflow<Trail>("visits")
      .step(
        defineStep("slow", async (input: Trail): Promise<Trail> => {
          await Promise.resolve();
          return { trail: [...input.trail, "slow"] };
        }),
      )
      .step(visit("after"))
      .build();

    const run = await workflow.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({ trail: ["slow", "after"] });
  });
});

describe("overriding a Workflow's Steps", () => {
  const visits = () =>
    defineWorkflow<Trail>("visits").step(visit("first")).step(visit("second")).build();

  const instead = defineStep(
    "instead",
    (input: Trail): Trail => ({ trail: [...input.trail, "instead"] }),
  );

  it("runs the supplied Step in the slot it names, and inherits the rest", async () => {
    const overridden = rewireWorkflow(visits(), { steps: { second: instead } });

    const run = await overridden.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({ trail: ["first", "instead"] });
    // The slot is unchanged and what filled it is not — the difference a response carries to
    // show a Developer that their Step ran.
    expect(run.steps).toEqual([
      { step: "first", implementation: "first" },
      { step: "second", implementation: "instead" },
    ]);
  });

  it("answers with the declaration it actually runs", async () => {
    // The trap, pinned. `describe` and `run` close over the array a Workflow was built with,
    // so an override written as `{ ...workflow, steps: mine }` would report the new list and
    // execute the old one — a Workflow claiming a Project's Step ran while Core's did. These
    // three are the three ways of asking what a Workflow is made of, and this fails the
    // moment they stop agreeing.
    const overridden = rewireWorkflow(visits(), { steps: { second: instead } });
    const run = await overridden.run({ trail: [] }, CONTEXT);

    expect(overridden.describe().steps.map((step) => step.slot)).toEqual([
      "first",
      "second",
    ]);
    expect(overridden.steps.map((entry) => [entry.slot, entry.step.name])).toEqual([
      ["first", "first"],
      ["second", "instead"],
    ]);
    expect(run.steps.map((step) => [step.step, step.implementation])).toEqual([
      ["first", "first"],
      ["second", "instead"],
    ]);
  });

  it("leaves the Workflow it was given alone", async () => {
    // A declaration is a value: overriding produces another one rather than rewiring Core's
    // for everybody in the process.
    const original = visits();

    rewireWorkflow(original, { steps: { second: instead } });
    const run = await original.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({ trail: ["first", "second"] });
  });

  it("refuses a slot the Workflow does not declare", () => {
    // A typo the compiler cannot see — a map assembled at runtime — would otherwise be an
    // override that silently does nothing, discovered as a price that never changed.
    expect(() =>
      rewireWorkflow(visits(), {
        steps: { third: instead } as StepOverrides<ReturnType<typeof visits>>,
      }),
    ).toThrow(/has no Step "third"/);
  });
});

/**
 * Insertion — the weaker mechanism, and weak on purpose (ADR-0017).
 *
 * A Developer inserts a Step to *observe* what a Workflow does without owning it. It cannot
 * alter the output contract, and that is the feature rather than a limitation: if insertion
 * could change the output there would be no reason to ever replace a Step. The types are
 * where that is enforced — see the compile-time assertions further down — and these cover
 * what running one does.
 */
describe("inserting a Step around another", () => {
  const visits = () =>
    defineWorkflow<Trail>("visits").step(visit("first")).step(visit("second")).build();

  const instead = defineStep(
    "instead",
    (input: Trail): Trail => ({ trail: [...input.trail, "instead"] }),
  );

  it("runs an inserted Step after the one it names, without replacing it", async () => {
    const rewired = rewireWorkflow(visits(), { after: { first: [visit("watching")] } });

    const run = await rewired.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // `first` still ran, and `watching` saw what it produced. Observation, not ownership.
    expect(run.output).toEqual({ trail: ["first", "watching", "second"] });
  });

  it("runs an inserted Step before the one it names", async () => {
    const rewired = rewireWorkflow(visits(), { before: { second: [visit("watching")] } });

    const run = await rewired.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({ trail: ["first", "watching", "second"] });
  });

  it("runs several inserted Steps in the order they were declared", async () => {
    const rewired = rewireWorkflow(visits(), {
      after: { first: [visit("watching"), visit("also-watching")] },
    });

    const run = await rewired.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({
      trail: ["first", "watching", "also-watching", "second"],
    });
  });

  it("shows an inserted Step in the declaration and in the run", async () => {
    // A Workflow's account of itself has to include what a Project inserted, or `describe()`
    // stops answering "what does this system do" for the deployment that is actually running.
    const rewired = rewireWorkflow(visits(), {
      before: { first: [visit("watching")] },
    });

    const run = await rewired.run({ trail: [] }, CONTEXT);

    expect(rewired.describe()).toEqual({
      name: "visits",
      steps: [{ slot: "watching" }, { slot: "first" }, { slot: "second" }],
    });
    expect(run.steps).toEqual([
      { step: "watching", implementation: "watching" },
      { step: "first", implementation: "first" },
      { step: "second", implementation: "second" },
    ]);
  });

  it("inserts around the slot rather than around the Step that fills it", async () => {
    // Replacement and insertion in the same config, on the same slot. What `after` names is
    // the *position*, so an insertion keeps pointing at the right place when a Project also
    // replaces what fills it.
    const rewired = rewireWorkflow(visits(), {
      steps: { second: instead },
      after: { second: [visit("watching")] },
    });

    const run = await rewired.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({ trail: ["first", "instead", "watching"] });
  });

  it("refuses to insert around a slot the Workflow does not declare", () => {
    expect(() =>
      rewireWorkflow(visits(), {
        after: { third: [visit("watching")] } as StepsAfter<ReturnType<typeof visits>>,
      }),
    ).toThrow(/has no Step "third"/);
  });

  it("refuses an inserted Step that takes the name of a declared slot", () => {
    // Slots are what an override map is keyed by, so two positions answering to `second`
    // would make `steps: { second: … }` replace both — an override doing twice what it says.
    expect(() =>
      rewireWorkflow(visits(), { after: { first: [visit("second")] } }),
    ).toThrow(/already declares a Step "second"/);
  });
});

/**
 * Compensation — what a Workflow does about the Steps that already succeeded when a later one
 * does not (ADR-0017).
 *
 * A Step declares how to undo itself, beside how to do itself, and Core unwinds in reverse
 * when the run stops. Reverse because a later Step's work may rest on an earlier one's, so
 * undoing in declaration order would take the ground out from under a compensation that had
 * not run yet.
 */
describe("compensating a Workflow that failed", () => {
  const refuses = defineStep("refuses", (_input: Trail): Trail => {
    throw new StepFailure("nothing-doing", "This Step declines to proceed.");
  });

  /** A Step with a bug in it: not a refusal, so it is not an answer the Workflow can give. */
  const broken = defineStep("broken", (_input: Trail): Trail => {
    throw new TypeError("undefined is not a function");
  });

  /** A Step that records having run and, given the chance, records having been undone. */
  const undoable = <Name extends string>(name: Name, unwound: string[]) =>
    defineStep(
      name,
      (input: Trail): Trail => ({ trail: [...input.trail, name] }),
      () => {
        unwound.push(name);
      },
    );

  it("runs the compensations of the Steps that completed, in reverse", async () => {
    const unwound: string[] = [];
    const workflow = defineWorkflow<Trail>("visits")
      .step(undoable("first", unwound))
      .step(undoable("second", unwound))
      .step(refuses)
      .build();

    const run = await workflow.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(false);
    expect(unwound).toEqual(["second", "first"]);
  });

  it("does not compensate the Step that refused, because it never completed", async () => {
    const unwound: string[] = [];
    const workflow = defineWorkflow<Trail>("visits")
      .step(undoable("first", unwound))
      .step(
        defineStep(
          "refuses",
          (_input: Trail): Trail => {
            throw new StepFailure("nothing-doing", "This Step declines to proceed.");
          },
          () => {
            unwound.push("refuses");
          },
        ),
      )
      .build();

    await workflow.run({ trail: [] }, CONTEXT);

    expect(unwound).toEqual(["first"]);
  });

  it("hands a compensation the very value its Step ran on", async () => {
    // The promise a Step's own bookkeeping rests on: whatever a Step did with the value it
    // was given, it is handed that same value back to undo it. Identity rather than equality,
    // because a Step may key what it wrote by the value itself.
    const seen: Trail[] = [];
    const input: Trail = { trail: [] };
    const workflow = defineWorkflow<Trail>("visits")
      .step(
        defineStep(
          "watching",
          (given: Trail): Trail => given,
          (given: Trail) => {
            seen.push(given);
          },
        ),
      )
      .step(refuses)
      .build();

    await workflow.run(input, CONTEXT);

    expect(seen[0]).toBe(input);
  });

  it("unwinds when a Step throws a bug too, and still lets the bug travel", async () => {
    // A refusal and a bug are different answers to give the caller, and the same mess to
    // leave behind. What the caller is told is not a reason to leave a half-done Workflow.
    const unwound: string[] = [];
    const workflow = defineWorkflow<Trail>("visits")
      .step(undoable("first", unwound))
      .step(broken)
      .build();

    await expect(workflow.run({ trail: [] }, CONTEXT)).rejects.toThrow(
      "undefined is not a function",
    );
    expect(unwound).toEqual(["first"]);
  });

  /** A Step whose compensation is itself broken — the case ADR-0036 is about. */
  const uncompensatable = <Name extends string>(name: Name) =>
    defineStep(
      name,
      (input: Trail): Trail => ({ trail: [...input.trail, name] }),
      () => {
        throw new TypeError(`the compensation of ${name} is itself broken`);
      },
    );

  it("keeps unwinding past a compensation that throws, so the Steps before it still get their turn", async () => {
    // ADR-0036. A compensation is by nature the code most likely to be running against a
    // system already in a bad state, so one of them failing must not decide the fate of the
    // others: `second` throws in the middle of the unwinding and `first`, which is earlier in
    // the chain and later in the unwinding, is still undone.
    const unwound: string[] = [];
    const workflow = defineWorkflow<Trail>("visits")
      .step(undoable("first", unwound))
      .step(uncompensatable("second"))
      .step(undoable("third", unwound))
      .step(refuses)
      .build();

    await workflow.run({ trail: [] }, CONTEXT);

    expect(unwound).toEqual(["third", "first"]);
  });

  it("answers with the refusal that stopped the run, and names what was left uncompensated", async () => {
    // The two facts are different questions — "why was this rejected" and "is the Store now
    // consistent" — and the second must not erase the first (ADR-0036). #8 shipped the
    // opposite and pinned it; #59 revisited it.
    const workflow = defineWorkflow<Trail>("visits")
      .step(undoable("first", []))
      .step(uncompensatable("second"))
      .step(refuses)
      .build();

    const run = await workflow.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.reason).toBe("nothing-doing");
    expect(run.failed).toBe("refuses");
    expect(run.uncompensated).toEqual([{ slot: "second", cause: expect.any(TypeError) }]);
  });

  it("reports nothing uncompensated when every compensation did its job", async () => {
    const workflow = defineWorkflow<Trail>("visits")
      .step(undoable("first", []))
      .step(refuses)
      .build();

    const run = await workflow.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.uncompensated).toEqual([]);
  });

  it("carries the bug that stopped the run as the cause of a failed unwinding", async () => {
    // A bug travels rather than becoming an answer, and it still does when the unwinding it
    // triggered also failed — but now it arrives *with* that news rather than being replaced
    // by it. A thrown outcome has no result object to hang the second fact on, so it hangs on
    // the error: the Steps left uncompensated are named in the message, and the bug is the
    // cause.
    const unwound: string[] = [];
    const workflow = defineWorkflow<Trail>("visits")
      .step(undoable("first", unwound))
      .step(uncompensatable("second"))
      .step(undoable("third", unwound))
      .step(broken)
      .build();

    const thrown: unknown = await workflow
      .run({ trail: [] }, CONTEXT)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UnwindFailure);
    if (!(thrown instanceof UnwindFailure)) return;
    // Both facts in the one line, because the thing that logs an error kobai raised logs its
    // message: a broken Step must not go quieter for having also broken its own cleanup.
    expect(thrown.message).toMatch(/left 1 Step uncompensated: "second"/);
    expect(thrown.message).toMatch(/undefined is not a function/);
    expect(thrown.cause).toBeInstanceOf(TypeError);
    expect((thrown.cause as Error).message).toBe("undefined is not a function");
    expect(thrown.uncompensated).toEqual([
      { slot: "second", cause: expect.any(TypeError) },
    ]);
    // The unwinding still finished around the compensation that threw, on this path too.
    expect(unwound).toEqual(["third", "first"]);
  });

  it("compensates nothing when every Step succeeds", async () => {
    const unwound: string[] = [];
    const workflow = defineWorkflow<Trail>("visits")
      .step(undoable("first", unwound))
      .step(undoable("second", unwound))
      .build();

    const run = await workflow.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(true);
    expect(unwound).toEqual([]);
  });

  it("unwinds the Steps a Project inserted alongside Core's own", async () => {
    // Insertion and compensation are one mechanism from the runner's side: an inserted Step
    // is a position like any other, so what it did is undone like anything else's.
    const unwound: string[] = [];
    const workflow = defineWorkflow<Trail>("visits")
      .step(undoable("first", unwound))
      .step(refuses)
      .build();

    const rewired = rewireWorkflow(workflow, {
      after: { first: [undoable("watching", unwound)] },
    });
    await rewired.run({ trail: [] }, CONTEXT);

    expect(unwound).toEqual(["watching", "first"]);
  });
});

/**
 * Composition — a Step invoking another declared Workflow (ADR-0054).
 *
 * The Workflow seam is where this belongs for the same reason replacement is here: what
 * composition promises is about the declarations, and no response body carries it. Three
 * promises, and they are separable — the deployment's version of the inner Workflow is what
 * runs; an inner refusal is a value the invoking Step decides about while a bug still travels;
 * and an inner Workflow that completed is unwound when a later outer Step fails, which is the
 * one nothing outside the runner could arrange.
 */
describe("invoking another Workflow from a Step", () => {
  /** A Step that records having run and, given the chance, records having been undone. */
  const undoable = <Name extends string>(name: Name, unwound: string[]) =>
    defineStep(
      name,
      (input: Trail): Trail => ({ trail: [...input.trail, name] }),
      () => {
        unwound.push(name);
      },
    );

  const refuses = defineStep("refuses", (_input: Trail): Trail => {
    throw new StepFailure("nothing-doing", "This Step declines to proceed.");
  });

  /** The Workflow being invoked, in the shape Core's own will take: named, and declared once. */
  const inner = defineWorkflow<Trail>("inner")
    .step(visit("inner-first"))
    .step(visit("inner-second"))
    .build();

  /** The ordinary invoking Step: run the inner Workflow, pass its refusal on, use its output. */
  const invokes = defineStep("invokes", async (input: Trail, context): Promise<Trail> => {
    const run = await runWorkflow(inner, input, context);
    if (!run.ok) throw new StepFailure(run.reason, run.detail);
    return run.output;
  });

  /**
   * The same Step over any inner Workflow, for the tests whose subject is the unwinding rather
   * than what the invoking Step decides. It carries on past a refusal, so nothing below is
   * asserting the unwinding of a run that was stopped by the Step it is about.
   */
  const invoking = <Shapes extends StepShapes>(
    workflow: Workflow<Trail, Trail, Shapes>,
    compensate?: () => void,
  ) =>
    defineStep(
      "invokes",
      async (input: Trail, context): Promise<Trail> => {
        const run = await runWorkflow(workflow, input, context);
        return run.ok ? run.output : input;
      },
      compensate,
    );

  it("runs the invoked Workflow's Steps, and the invoking Step answers with its output", async () => {
    const outer = defineWorkflow<Trail>("outer")
      .step(visit("outer-first"))
      .step(invokes)
      .step(visit("outer-last"))
      .build();

    const run = await outer.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // Order proved by the value itself, as everywhere else here: the inner Steps appended
    // their names in the middle, so the inner Workflow ran where the invoking Step sat.
    expect(run.output).toEqual({
      trail: ["outer-first", "inner-first", "inner-second", "outer-last"],
    });
  });

  it("keeps the outer run's account of itself to its own Steps", async () => {
    // The inner Workflow is not flattened into the outer one. `steps` names the positions the
    // outer declaration has, and an inner Step fills none of them — a Workflow's report of
    // which Steps ran has to keep meaning "the Steps this declaration declares".
    const outer = defineWorkflow<Trail>("outer").step(invokes).build();

    const run = await outer.run({ trail: [] }, CONTEXT);

    expect(run.steps).toEqual([{ step: "invokes", implementation: "invokes" }]);
  });

  it("runs the deployment's declaration of that Workflow rather than the one it was handed", async () => {
    // The whole point. The Step imports Core's declaration because that is the only one it
    // can name; the registry is how the deployment's rebuilt version of it is found from it.
    const deployed = rewireWorkflow(inner, {
      steps: { "inner-second": visit("the-projects-own") },
    });
    const outer = defineWorkflow<Trail>("outer").step(invokes).build();

    const run = await outer.run(
      { trail: [] },
      { ...CONTEXT, workflows: { inner: deployed } },
    );

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({ trail: ["inner-first", "the-projects-own"] });
  });

  it("runs the declaration it was handed when the deployment declares no such Workflow", async () => {
    // Absent is a working answer, not a broken one: a Workflow assembled outside a deployment
    // — in a test, in a script — has no registry behind it and still runs.
    const outer = defineWorkflow<Trail>("outer").step(invokes).build();

    const run = await outer.run(
      { trail: [] },
      { ...CONTEXT, workflows: { "some-other-workflow": inner } },
    );

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({ trail: ["inner-first", "inner-second"] });
  });

  it("hands an inner Workflow's refusal to the Step that invoked it, as a refusal", async () => {
    // A value rather than a throw, because the invoking Step is the only thing in a position
    // to say what an inner Workflow declining means for the process around it.
    const refusing = rewireWorkflow(inner, { steps: { "inner-second": refuses } });
    const seen: unknown[] = [];
    const watching = defineStep(
      "watching",
      async (input: Trail, context): Promise<Trail> => {
        const run = await runWorkflow(refusing, input, context);
        seen.push(run);
        return input;
      },
    );

    await defineWorkflow<Trail>("outer")
      .step(watching)
      .build()
      .run({ trail: [] }, CONTEXT);

    expect(seen).toEqual([
      {
        ok: false,
        // The *inner* slot that refused, named by the inner declaration.
        failed: "inner-second",
        reason: "nothing-doing",
        detail: "This Step declines to proceed.",
        steps: [{ step: "inner-first", implementation: "inner-first" }],
        uncompensated: [],
      },
    ]);
  });

  it("refuses the outer run with the inner reason, at the outer slot, when the Step passes it on", async () => {
    // Passing it on is one `StepFailure` away, and this is what the caller then sees: the
    // reason is the inner Workflow's, and the slot is the outer position that stopped — which
    // is the only one the outer declaration has a name for.
    const refusing = rewireWorkflow(inner, { steps: { "inner-second": refuses } });
    const passesItOn = defineStep(
      "passes-it-on",
      async (input: Trail, context): Promise<Trail> => {
        const run = await runWorkflow(refusing, input, context);
        if (!run.ok) throw new StepFailure(run.reason, run.detail);
        return run.output;
      },
    );
    const outer = defineWorkflow<Trail>("outer")
      .step(visit("outer-first"))
      .step(passesItOn)
      .build();

    const run = await outer.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.reason).toBe("nothing-doing");
    expect(run.failed).toBe("passes-it-on");
    expect(run.steps).toEqual([{ step: "outer-first", implementation: "outer-first" }]);
  });

  it("lets a bug in an inner Step travel as itself", async () => {
    // ADR-0036 across the boundary: a bug is not a decision the inner Workflow made, so it is
    // not dressed up as one on the way out of the outer Step either.
    const broken = rewireWorkflow(inner, {
      steps: {
        "inner-second": defineStep("broken", (_input: Trail): Trail => {
          throw new TypeError("undefined is not a function");
        }),
      },
    });
    await expect(
      defineWorkflow<Trail>("outer")
        .step(invoking(broken))
        .build()
        .run({ trail: [] }, CONTEXT),
    ).rejects.toThrow("undefined is not a function");
  });

  it("unwinds a completed inner Workflow when a later outer Step fails", async () => {
    // The promise composition could most easily have failed to make. The inner Workflow
    // succeeded, so it unwound nothing of its own; a later outer Step then fails, and what the
    // inner Steps did is undone all the same — newest first, across the boundary.
    const unwound: string[] = [];
    const writing = defineWorkflow<Trail>("inner")
      .step(undoable("inner-first", unwound))
      .step(undoable("inner-second", unwound))
      .build();
    const outer = defineWorkflow<Trail>("outer")
      .step(undoable("outer-first", unwound))
      .step(invoking(writing))
      .step(refuses)
      .build();

    await outer.run({ trail: [] }, CONTEXT);

    expect(unwound).toEqual(["inner-second", "inner-first", "outer-first"]);
  });

  it("undoes the invoking Step before the Workflow it invoked", async () => {
    // A Step sits *outside* what it called, so the nesting decides the order rather than the
    // instant each thing happened at. Its own compensation undoes its own work; the Workflow
    // it delegated to unwinds after, in reverse, exactly as it would anywhere else.
    const unwound: string[] = [];
    const writing = defineWorkflow<Trail>("inner")
      .step(undoable("inner-first", unwound))
      .step(undoable("inner-second", unwound))
      .build();
    const outer = defineWorkflow<Trail>("outer")
      .step(
        invoking(writing, () => {
          unwound.push("invokes");
        }),
      )
      .step(refuses)
      .build();

    await outer.run({ trail: [] }, CONTEXT);

    expect(unwound).toEqual(["invokes", "inner-second", "inner-first"]);
  });

  it("unwinds what a Step delegated even when that Step is the one that fails", async () => {
    // The Step never completed, so it has no compensation of its own to run — and the
    // Workflow it had already finished is exactly the work that would otherwise be reached by
    // nothing at all.
    const unwound: string[] = [];
    const writing = defineWorkflow<Trail>("inner")
      .step(undoable("inner-first", unwound))
      .build();
    const outer = defineWorkflow<Trail>("outer")
      .step(
        defineStep(
          "invokes-then-refuses",
          async (input: Trail, context): Promise<Trail> => {
            await runWorkflow(writing, input, context);
            throw new StepFailure("nothing-doing", "This Step declines to proceed.");
          },
          () => {
            unwound.push("invokes-then-refuses");
          },
        ),
      )
      .build();

    const run = await outer.run({ trail: [] }, CONTEXT);

    expect(run.ok).toBe(false);
    expect(unwound).toEqual(["inner-first"]);
  });

  it("does not unwind an inner Workflow twice when it refused and undid itself", async () => {
    // An inner Workflow that refuses unwinds its own completed Steps there and then, and
    // hands nothing up. Compensation is attempted exactly once per Step, and a boundary is no
    // reason for that to stop being true.
    const unwound: string[] = [];
    const refusing = defineWorkflow<Trail>("inner")
      .step(undoable("inner-first", unwound))
      .step(refuses)
      .build();
    const outer = defineWorkflow<Trail>("outer")
      .step(undoable("outer-first", unwound))
      .step(
        defineStep("invokes", async (input: Trail, context): Promise<Trail> => {
          const run = await runWorkflow(refusing, input, context);
          if (!run.ok) throw new StepFailure(run.reason, run.detail);
          return run.output;
        }),
      )
      .build();

    await outer.run({ trail: [] }, CONTEXT);

    expect(unwound).toEqual(["inner-first", "outer-first"]);
  });

  it("hands an inner Step's compensation the very value its run was given", async () => {
    // The promise a Step's bookkeeping rests on, held across the boundary: an entry unwound by
    // a run that is not the one it was made in is still handed its own input.
    const seen: Trail[] = [];
    const writing = defineWorkflow<Trail>("inner")
      .step(
        defineStep(
          "remembers",
          (given: Trail): Trail => given,
          (given: Trail) => {
            seen.push(given);
          },
        ),
      )
      .build();
    const entered: Trail = { trail: [] };
    const outer = defineWorkflow<Trail>("outer")
      .step(invoking(writing))
      .step(refuses)
      .build();

    await outer.run(entered, CONTEXT);

    expect(seen[0]).toBe(entered);
  });

  it("hands an inner Step's compensation the context its own run was given", async () => {
    // The other half of that promise, and the half only composition makes visible: the entry
    // is unwound by the *outer* run, and still sees what the inner run was told rather than
    // what the outer one was. `metadata` is ADR-0013's open half, so a Step that read a lead
    // time on the way in reads the same one on the way back out.
    const seen: unknown[] = [];
    const writing = defineWorkflow<Trail>("inner")
      .step(
        defineStep(
          "remembers",
          (given: Trail): Trail => given,
          (_given: Trail, context) => {
            seen.push(context.metadata.leadTimeDays);
          },
        ),
      )
      .build();
    const outer = defineWorkflow<Trail>("outer")
      .step(
        defineStep("invokes", async (input: Trail, context): Promise<Trail> => {
          // Narrowing what the inner Workflow is told is the ordinary thing for an invoking
          // Step to do — a Step composing per Line Item will do exactly this.
          const run = await runWorkflow(writing, input, {
            ...context,
            metadata: { leadTimeDays: "10" },
          });
          return run.ok ? run.output : input;
        }),
      )
      .step(refuses)
      .build();

    await outer.run({ trail: [] }, { ...CONTEXT, metadata: { leadTimeDays: "outer" } });

    expect(seen).toEqual(["10"]);
  });

  it("reports an inner run's failed compensations to the Step that invoked it", async () => {
    // ADR-0036's second fact, at the boundary. The inner Workflow refused and unwound itself,
    // and one of its compensations threw — news about whether the Store is consistent, and it
    // arrives on the run the invoking Step is handed. Core deliberately does not merge it into
    // the outer run's list (ADR-0054), so this is the only place it can be read.
    const refusing = defineWorkflow<Trail>("inner")
      .step(
        defineStep(
          "uncompensatable",
          (given: Trail): Trail => given,
          () => {
            throw new TypeError("the compensation of uncompensatable is itself broken");
          },
        ),
      )
      .step(refuses)
      .build();
    const seen: unknown[] = [];
    const outer = defineWorkflow<Trail>("outer")
      .step(
        defineStep("invokes", async (input: Trail, context): Promise<Trail> => {
          const run = await runWorkflow(refusing, input, context);
          if (!run.ok) seen.push(run.uncompensated);
          return input;
        }),
      )
      .build();

    await outer.run({ trail: [] }, CONTEXT);

    expect(seen).toEqual([[{ slot: "uncompensatable", cause: expect.any(TypeError) }]]);
  });
});

/**
 * The same promise at the seam a Developer experiences it at: a booted deployment.
 *
 * `resolve-price` is the Workflow the spine will invoke per Line Item, and the reason
 * composition is being built before anything needs it is that a Project which replaced
 * `select-price` should not have to wire the same rule a second time to get it at Capture. So
 * the assertion is on a price a booted kobai produces through composition, not on a
 * declaration read back — booting is what puts the Project's config into the registry, and
 * the registry is the only thing standing between Core's Step and the Project's.
 */
describe("a Project's override of an inner Workflow's Step", () => {
  /**
   * The market these runs ask in — a Region this deployment has never heard of, deliberately.
   *
   * `resolve-price` is *handed* a Region rather than looking one up: the route resolves what
   * `?region=` named, or falls back to the Store's default, and refuses at 400 before the
   * Workflow is entered (`pricing/market.ts`). So a Step sees a market as a value, and a test at
   * this seam can name one — which is the property, not a shortcut. Its currency is the one
   * `seedTestCatalog` prices in, because an unconstrained Price applies here only if it is
   * denominated in the Region's currency.
   */
  const A_MARKET = {
    region: {
      id: "00000000-0000-4000-8000-000000000042",
      name: "Testland",
      currency: "USD",
    },
    channel: null,
  } as const;

  /** A Step that ignores every Price a Merchant entered and charges the same for everything. */
  const flatRate = defineStep(
    "flat-rate",
    (input: {
      readonly variant: ResolvedPrice["variant"];
      readonly region: ResolvedPrice["region"];
      readonly channel: ResolvedPrice["channel"];
    }): ResolvedPrice => ({
      variant: input.variant,
      region: input.region,
      channel: input.channel,
      price: { id: "flat-rate", amount: 4200, currency: "XTS" },
    }),
  );

  /** A Project's Step of its own, reaching `resolve-price` the one way there is. */
  const resolvesAPrice = defineStep(
    "resolves-a-price",
    async (input: PriceResolutionRequest, context): Promise<ResolvedPrice> => {
      const run = await runWorkflow(priceResolutionWorkflow, input, context);
      if (!run.ok) throw new StepFailure(run.reason, run.detail);
      return run.output;
    },
  );

  const composing = defineWorkflow<PriceResolutionRequest>("composing")
    .step(resolvesAPrice)
    .build();

  it("applies when that Workflow is reached from inside another one", async () => {
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": flatRate } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const run = await composing.run(
      { variantId: catalog.variantId, ...A_MARKET },
      { db: kobai.db, metadata: {}, workflows: kobai.workflows },
    );

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // Not the 1250 in the database, and nothing here named `flat-rate`: the Project said so
    // once, in its config, and composition is what carried it to a second caller.
    expect(run.output.price).toEqual({ id: "flat-rate", amount: 4200, currency: "XTS" });
  });

  it("is the only reason the price differs — the same composition inherits Core's Step", async () => {
    // The other half of the assertion above, so that neither is a claim about a run that was
    // never going to answer anything else.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const run = await composing.run(
      { variantId: catalog.variantId, ...A_MARKET },
      { db: kobai.db, metadata: {}, workflows: kobai.workflows },
    );

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output.price).toMatchObject({ amount: 1250 });
  });
});

/**
 * **What `resolve-price` promises its slots, in types** (#292, ADR-0017).
 *
 * That `select-price` is given the Region and the Channel is a promise about a *declared
 * Workflow*, and no response body can carry it: a deployment answering the right price says
 * nothing about what a Project's own Step would be handed. So it is asserted here, where the
 * `typecheck` step of the gate is what runs it — beside the synthetic Workflow below, and
 * against the real declaration, because this is a promise about that one.
 *
 * What an override *does* with the Region is a fact about a running deployment and is asserted
 * over HTTP, by booting with one: `pricing/a-price-in-a-region.test.ts`.
 */
describe("the input `resolve-price` hands its Steps", () => {
  type Loaded = StepInput<PriceResolutionWorkflow, "select-price">;

  it("carries the Region and the Channel as well as the Variant and the candidates", () => {
    const given: Loaded = {
      variant: { id: "…", sku: "POSTER-A2" },
      region: { id: "…", name: "Malaysia", currency: "MYR" },
      // `null` is the unconstrained Channel, which is what a key minted into none presents.
      channel: null,
      prices: [],
    };

    expect(given.region.currency).toBe("MYR");
  });

  it("rejects a replacement that produces a price without the market it was resolved for", () => {
    const overrides: StepOverrides<PriceResolutionWorkflow> = {
      // @ts-expect-error `select-price` gives back the Region and the Channel it was handed.
      "select-price": defineStep("forgets-the-market", (input: Loaded) => ({
        variant: input.variant,
        price: { id: "…", amount: 1, currency: input.region.currency },
      })),
    };

    expect(overrides).toBeDefined();
  });

  it("rejects an inserted Step that drops the Region on its way past", () => {
    const before: StepsBefore<PriceResolutionWorkflow> = {
      "select-price": [
        // @ts-expect-error what flows into `select-price` carries the market, so what a Step
        // before it hands on must carry it too — observation cannot quietly become mutation.
        defineStep("drops-the-region", (input: Loaded) => ({
          variant: input.variant,
          channel: input.channel,
          prices: input.prices,
        })),
      ],
    };

    expect(before).toBeDefined();
  });
});

/**
 * What a Step declares, as the compiler sees it.
 *
 * These assertions are checked by `pnpm -r typecheck`, which includes this file — a design
 * that stopped holding them would fail the gate rather than the run. They exist because
 * "Steps are typed: each declares its input and its output" is a promise about the *types*,
 * and no assertion on a value can carry it.
 */
describe("the types a Step declares", () => {
  const workflow = defineWorkflow<{ readonly sku: string }>("priced")
    .step(
      defineStep("load", (_input: { readonly sku: string }) => ({
        amounts: [1250, 900] as readonly number[],
      })),
    )
    .step(
      defineStep("select", (input: { readonly amounts: readonly number[] }) => ({
        amount: input.amounts[0] ?? 0,
      })),
    )
    .build();

  type Priced = typeof workflow;
  /** Exactly the shape ADR-0017's override map will ask for: free name, fixed types. */
  type Replacement = Step<
    string,
    StepInput<Priced, "select">,
    StepOutput<Priced, "select">
  >;

  it("names every slot", () => {
    const slots: WorkflowSlots<Priced>[] = ["load", "select"];

    expect(workflow.describe().steps.map((step) => step.slot)).toEqual(slots);
  });

  it("accepts a differently named Step that takes and gives what the slot does", async () => {
    const cheapest: Replacement = defineStep(
      "cheapest-price",
      (input: { readonly amounts: readonly number[] }) => ({
        amount: Math.min(...input.amounts),
      }),
    );

    await expect(
      Promise.resolve(cheapest.run({ amounts: [1250, 900] }, CONTEXT)),
    ).resolves.toEqual({ amount: 900 });
  });

  it("rejects a Step that produces something else", () => {
    // @ts-expect-error `select` gives `{ amount }`, and this gives `{ total }`.
    const wrong: Replacement = defineStep(
      "wrong-output",
      (_input: { readonly amounts: readonly number[] }) => ({ total: 0 }),
    );

    expect(wrong).toBeDefined();
  });

  it("rejects a Step that demands more than the slot provides", () => {
    // Contravariance, and the reason `run` is a function-valued property rather than a
    // method: a Step that insists on a field the Workflow does not carry would be handed
    // `undefined` at runtime, and TypeScript only says so for a property.
    // @ts-expect-error `select` is given `{ amounts }` alone.
    const fussy: Replacement = defineStep(
      "fussy-input",
      (input: { readonly amounts: readonly number[]; readonly quantity: number }) => ({
        amount: (input.amounts[0] ?? 0) * input.quantity,
      }),
    );

    expect(fussy).toBeDefined();
  });

  /**
   * The same two rejections, at the surface a Project actually writes.
   *
   * The pair above prove the `Step` type can express the constraint; these prove the override
   * map applies it, which is the promise — ADR-0017's "a replacement must satisfy the original
   * Step's input and output types" is about the map in `kobai.config.ts`, not about a type
   * alias a Developer would never write. Both are checked by the `typecheck` step of the gate,
   * so neither can regress into a runtime surprise silently.
   */
  it("accepts an override whose Step takes and gives what the slot does", async () => {
    const overridden = rewireWorkflow(workflow, {
      steps: {
        select: defineStep(
          "cheapest-price",
          (input: { readonly amounts: readonly number[] }) => ({
            amount: Math.min(...input.amounts),
          }),
        ),
      },
    });

    const run = await overridden.run({ sku: "POSTER-A2" }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({ amount: 900 });
  });

  it("rejects an override whose Step produces something else", () => {
    const overrides: StepOverrides<Priced> = {
      // @ts-expect-error `select` gives `{ amount }`, and this gives `{ total }`.
      select: defineStep(
        "wrong-output",
        (_input: { readonly amounts: readonly number[] }) => ({ total: 0 }),
      ),
    };

    expect(overrides).toBeDefined();
  });

  it("rejects an override whose Step demands more than the slot provides", () => {
    const overrides: StepOverrides<Priced> = {
      // @ts-expect-error `select` is given `{ amounts }` alone.
      select: defineStep(
        "fussy-input",
        (input: { readonly amounts: readonly number[]; readonly quantity: number }) => ({
          amount: (input.amounts[0] ?? 0) * input.quantity,
        }),
      ),
    };

    expect(overrides).toBeDefined();
  });

  it("rejects an override naming a slot the Workflow does not declare", () => {
    // @ts-expect-error `priced` declares `load` and `select`, and nothing called `discount`.
    const overrides: StepOverrides<Priced> = { discount: defineStep("free", () => ({})) };

    expect(overrides).toBeDefined();
  });

  /**
   * Why insertion is the weaker mechanism, in types.
   *
   * An inserted Step's input and output are pinned to the *same* type — what the slot is
   * given, for a Step going before it, and what the slot produces, for one going after. So a
   * Step may look at the value and must hand back the same shape: observation cannot quietly
   * become mutation (spec story 29). No new machinery does this; it is the same check that
   * rejects a bad replacement, applied to a narrower shape.
   */
  it("accepts an inserted Step that hands back what it was given", async () => {
    const after: StepsAfter<Priced> = {
      select: [
        defineStep("watching", (input: { readonly amount: number }) => ({
          amount: input.amount,
        })),
      ],
    };

    const rewired = rewireWorkflow(workflow, { after });
    const run = await rewired.run({ sku: "POSTER-A2" }, CONTEXT);

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output).toEqual({ amount: 1250 });
  });

  it("rejects an inserted Step that alters the Workflow's output", () => {
    const after: StepsAfter<Priced> = {
      select: [
        // @ts-expect-error `select` gives `{ amount }`, so a Step after it must give one too.
        defineStep("doubles-the-total", (input: { readonly amount: number }) => ({
          total: input.amount * 2,
        })),
      ],
    };

    expect(after).toBeDefined();
  });

  it("rejects an inserted Step that alters what the Step it precedes is given", () => {
    const before: StepsBefore<Priced> = {
      select: [
        // @ts-expect-error `select` is given `{ amounts }`, so a Step before it must give one.
        defineStep(
          "drops-the-amounts",
          (_input: { readonly amounts: readonly number[] }) => ({ amount: 0 }),
        ),
      ],
    };

    expect(before).toBeDefined();
  });

  /**
   * What composition promises in types (ADR-0054).
   *
   * A Workflow is entered with the type it declared, and its answer is a refusal *or* an
   * output — so the second of these is the whole reason a run is a union rather than a value
   * with an optional error on it. A Step that forgot an inner Workflow could decline would
   * otherwise read `undefined` and carry it into the outer output.
   */
  it("rejects an input the invoked Workflow does not take", async () => {
    const run = await runWorkflow(
      workflow,
      // @ts-expect-error `priced` is entered with `{ sku }`, and this is a list of amounts.
      { amounts: [1250] },
      CONTEXT,
    );

    expect(run.ok).toBe(true);
  });

  it("refuses to read an invoked Workflow's output before the refusal is dealt with", async () => {
    const run = await runWorkflow(workflow, { sku: "POSTER-A2" }, CONTEXT);

    // @ts-expect-error a run may have refused, so there is no `output` until `ok` is narrowed.
    const output: unknown = run.output;

    expect(output).toEqual({ amount: 1250 });
  });

  it("rejects an inserted Step that demands more than the position provides", () => {
    const before: StepsBefore<Priced> = {
      select: [
        // @ts-expect-error `select` is given `{ amounts }` alone.
        defineStep(
          "fussy-observer",
          (input: {
            readonly amounts: readonly number[];
            readonly quantity: number;
          }) => ({ amounts: input.amounts.slice(0, input.quantity) }),
        ),
      ],
    };

    expect(before).toBeDefined();
  });
});
