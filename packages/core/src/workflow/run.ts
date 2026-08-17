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
      /**
       * The Steps whose compensation threw while unwinding, in the order they were attempted
       * — so, newest first (ADR-0036).
       *
       * Empty on an ordinary refusal, and that is the case worth naming: it says the Store
       * was left as the Workflow found it. A non-empty list is the *other* fact about this
       * run — not why it was refused, but whether the Store is now consistent — and it is
       * reported beside the refusal rather than in place of it, because the caller who asked
       * "why was this rejected" is still owed the answer.
       */
      readonly uncompensated: readonly CompensationFailure[];
    };

/** One compensation that threw: the slot whose Step declared it, and what it threw. */
export type CompensationFailure = {
  readonly slot: string;
  readonly cause: unknown;
};

/**
 * Unwinding finished, and one or more compensations threw while it did — raised only when
 * what stopped the run was a **bug** rather than a refusal.
 *
 * A refusal is a value, so the compensations that failed are reported on it (see
 * {@link WorkflowRun}). A bug is a throw, and there is no value to report anything on — so
 * the second fact travels attached to the first: the bug is this error's `cause`, and the
 * Steps left uncompensated are named in the message and listed on `uncompensated`. Neither
 * fact replaces the other, which is the whole of ADR-0036.
 *
 * It is an `AggregateError` because that is what it is — every compensation that threw is in
 * `errors`, in the order they were attempted — and because a runner that picked one of them
 * to re-raise would be choosing which half of the mess an operator gets to read.
 */
export class UnwindFailure extends AggregateError {
  readonly uncompensated: readonly CompensationFailure[];

  constructor(cause: unknown, uncompensated: readonly CompensationFailure[]) {
    super(
      uncompensated.map((failure) => failure.cause),
      describeUnwindFailure(cause, uncompensated),
      { cause },
    );
    this.name = "UnwindFailure";
    this.uncompensated = uncompensated;
  }
}

/**
 * Both facts, in one line.
 *
 * The message carries what stopped the run as well as what the unwinding could not undo,
 * because the thing that logs an error kobai raised logs its `message` and nothing else — so
 * a wrapper that kept the original only in `cause` would make a broken Step *quieter* than it
 * was before it also broke its own cleanup, which is the opposite of the point.
 */
function describeUnwindFailure(
  cause: unknown,
  uncompensated: readonly CompensationFailure[],
): string {
  const slots = uncompensated.map((failure) => JSON.stringify(failure.slot)).join(", ");
  const steps = `${uncompensated.length} Step${uncompensated.length === 1 ? "" : "s"}`;
  return `A Workflow failed, and unwinding it left ${steps} uncompensated: ${slots}. The Store may be inconsistent. What stopped the run: ${messageOf(cause)}`;
}

/** What a thrown thing says for itself. A Step may throw anything, so nothing is assumed. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

/** What a Step's `run` looks like once the declaration's types have been discharged. */
type Erased = (input: unknown, context: WorkflowContext) => unknown;

/** Likewise a Step's compensation, together with what it is owed: the value its Step ran on. */
type Undo = {
  /** The slot it belongs to, so a compensation that throws can be reported by position. */
  readonly slot: string;
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
      const uncompensated = await unwind(undo, context);

      // Only a refusal is an answer. Anything else is a bug in a Step, and a bug must not be
      // dressed up as a decision the Workflow made — it keeps travelling, and surfaces as
      // the 500 it is. It travels alone unless the unwinding failed too, in which case it
      // travels as the cause of that (ADR-0036): a thrown outcome has no result object for
      // the second fact to be reported on, and dropping it would leave the more urgent of
      // the two — the Store may be inconsistent — nowhere at all.
      if (!(cause instanceof StepFailure))
        throw uncompensated.length === 0
          ? cause
          : new UnwindFailure(cause, uncompensated);

      return {
        ok: false,
        failed: entry.slot,
        reason: cause.reason,
        detail: cause.detail,
        steps: ran,
        uncompensated,
      };
    }

    ran.push({ step: entry.slot, implementation: entry.step.name });
    // The failing Step is not among these: it did not complete, so there is nothing of its
    // to undo, and calling its compensation would be asking it to unwind work it never did.
    const compensate = entry.step.compensate as Undo["compensate"] | undefined;
    if (compensate) undo.push({ slot: entry.slot, compensate, input: given });
  }

  return { ok: true, output: value as Out, steps: ran };
}

/**
 * Undoes the completed Steps, newest first, and reports the compensations that threw.
 *
 * Reverse because a later Step's work may rest on an earlier one's — undoing in declaration
 * order would pull the ground out from under a compensation that had not run yet. Each Step
 * is handed the value it ran on, so a Step that wrote something can find what it wrote.
 *
 * **Every completed Step's compensation is attempted, and one that throws does not stop the
 * rest** (ADR-0036). A compensation is by nature the code most likely to be running against a
 * system already in a bad state, so its failing is the ordinary case rather than the remote
 * one — and stopping there would leave the Steps *before* it uncompensated, in exactly the
 * situation compensation exists to prevent. Which Steps got undone would then depend on where
 * in the chain the failure landed, which is the opposite of the predictability the reverse
 * order is for.
 *
 * Nothing is thrown from here. What one compensation failing means for the run is the
 * runner's decision, not this loop's, and this loop is not in a position to make it: it does
 * not know whether a refusal or a bug brought it here.
 */
async function unwind(
  undo: readonly Undo[],
  context: WorkflowContext,
): Promise<readonly CompensationFailure[]> {
  const uncompensated: CompensationFailure[] = [];

  for (const entry of [...undo].reverse()) {
    try {
      await entry.compensate(entry.input, context);
    } catch (cause) {
      uncompensated.push({ slot: entry.slot, cause });
    }
  }

  return uncompensated;
}
