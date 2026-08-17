import { describe, expect, it } from "vitest";
import type { Database } from "../db/client.ts";
import { openMetadata, type WorkflowContext } from "./context.ts";
import { UnwindFailure } from "./run.ts";
import { defineStep, type Step, StepFailure } from "./step.ts";
import {
  defineWorkflow,
  rewireWorkflow,
  type StepInput,
  type StepOutput,
  type StepOverrides,
  type StepsAfter,
  type StepsBefore,
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
