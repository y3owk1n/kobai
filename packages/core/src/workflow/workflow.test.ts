import { describe, expect, it } from "vitest";
import type { Database } from "../db/client.ts";
import { defineStep, type Step, StepFailure, type WorkflowContext } from "./step.ts";
import {
  defineWorkflow,
  type StepInput,
  type StepOutput,
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
      steps: [{ name: "double" }, { name: "stringify" }],
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

    expect(workflow.describe().steps.map((step) => step.name)).toEqual(slots);
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
});
