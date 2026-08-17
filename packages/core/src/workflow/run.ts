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
 * See {@link WorkflowStep} for why those are two things. Reporting both is what lets a
 * Developer see in the response that *their* Step ran (spec story 33): the slot stays Core's
 * and the implementation beside it is theirs, so the response says so without the contract
 * having to change to accommodate an override.
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

/** Likewise a Step's compensation, together with what it is owed: the value its Step ran on. */
type Undo = {
  readonly compensate: (input: unknown, context: WorkflowContext) => void | Promise<void>;
  readonly input: unknown;
};

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
  const undo: Undo[] = [];
  let value = input;

  for (const entry of steps) {
    const given = value;
    try {
      value = await (entry.step.run as Erased)(given, context);
    } catch (cause) {
      // Unwound before the answer is composed, and before a bug is allowed to travel: what
      // the caller is told is a different question from whether the Store is left consistent,
      // and a refusal and a bug leave exactly the same mess behind.
      await unwind(undo, context);

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
    // The failing Step is not among these: it did not complete, so there is nothing of its
    // to undo, and calling its compensation would be asking it to unwind work it never did.
    const compensate = entry.step.compensate as Undo["compensate"] | undefined;
    if (compensate) undo.push({ compensate, input: given });
  }

  return { ok: true, output: value as Out, steps: ran };
}

/**
 * Undoes the completed Steps, newest first.
 *
 * Reverse because a later Step's work may rest on an earlier one's — undoing in declaration
 * order would pull the ground out from under a compensation that had not run yet. Each Step
 * is handed the value it ran on, so a Step that wrote something can find what it wrote.
 *
 * A compensation that throws is a bug like any other, and it travels: unwinding stops there
 * rather than continuing over a machine that has just proved it does not understand its own
 * state, and the failure is reported rather than swallowed into a Workflow that claims to
 * have cleaned up after itself.
 */
async function unwind(undo: readonly Undo[], context: WorkflowContext): Promise<void> {
  for (const entry of [...undo].reverse()) {
    await entry.compensate(entry.input, context);
  }
}
