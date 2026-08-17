import type { WorkflowContext } from "./context.ts";
import { StepFailure } from "./step.ts";
import type { WorkflowStep } from "./workflow.ts";

/**
 * Core's runner: it executes a Workflow's Steps in declared order and answers with the last
 * one's output.
 *
 * It is the *only* thing that knows how a Workflow is executed, which is what keeps the
 * declaration free to be read, described and — from the next ticket on — rewired.
 */

/**
 * One Step, as the run reports it: the slot it filled, and what filled it.
 *
 * See {@link WorkflowStep} for why those are two things. Reporting both here — while they
 * still always agree, because nothing has been replaced yet — is what will let a Developer
 * see in the response that *their* Step ran (spec story 33) without the response contract
 * having to change to say so.
 */
export type StepReport = {
  readonly step: string;
  readonly implementation: string;
};

/**
 * What a run produced, or which Step refused and why.
 *
 * A result rather than an exception, because a Workflow refusing is an ordinary answer — a
 * Variant with no Price is not a broken server. A refusal carries every Step that completed
 * before it, so the report is a true account of how far the process got.
 */
export type WorkflowRun<Out> =
  | {
      readonly ok: true;
      readonly output: Out;
      readonly steps: readonly StepReport[];
    }
  | {
      readonly ok: false;
      /** The slot that refused. */
      readonly failed: string;
      readonly reason: string;
      readonly detail: string;
      /** The Steps that completed. The one named by `failed` is not among them. */
      readonly steps: readonly StepReport[];
    };

/** What a Step's `run` looks like once the declaration's types have been discharged. */
type Erased = (input: unknown, context: WorkflowContext) => unknown;

/**
 * Runs the given Steps in order, threading each one's output into the next.
 *
 * The cast is the one place the declaration's type safety is cashed in: `WorkflowBuilder`
 * refused to accept a Step whose input did not match what the previous one produced, so by
 * construction the value in hand is what the next Step declared it takes. Checking it again
 * here is not possible — a type is not a runtime value — and the alternative, a runtime
 * schema per Step, would be a second declaration to keep in step with the first.
 */
export async function runSteps<Out>(
  steps: readonly WorkflowStep[],
  input: unknown,
  context: WorkflowContext,
): Promise<WorkflowRun<Out>> {
  const ran: StepReport[] = [];
  let value = input;

  for (const entry of steps) {
    try {
      value = await (entry.step.run as Erased)(value, context);
    } catch (cause) {
      // Only a refusal is an answer. Anything else is a bug in a Step, and a bug must not be
      // dressed up as a decision the Workflow made — it keeps travelling, and surfaces as
      // the 500 it is.
      if (!(cause instanceof StepFailure)) throw cause;

      return {
        ok: false,
        failed: entry.slot,
        reason: cause.reason,
        detail: cause.detail,
        steps: ran,
      };
    }

    ran.push({ step: entry.slot, implementation: entry.step.name });
  }

  return { ok: true, output: value as Out, steps: ran };
}
