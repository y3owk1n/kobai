import type { PaymentProvider } from "../payment/provider.ts";
import type { WorkflowRegistry } from "../workflow/context.ts";
import type { StepOrigin } from "../workflow/workflow.ts";

/**
 * What a running deployment is, as an answer a Developer can ask for (ADR-0080).
 *
 * A **Deployment** is one running Project — one process, one database, one Store — and until
 * `GET /admin/deployment` there was no way to ask it what it had been configured into.
 * Everything here is decided in `kobai.config.ts` and then disappears into a process: which
 * release of Core this is, which Step is filling each of a Workflow's positions, whether a
 * Payment Provider is wired.
 *
 * **Three things, and deliberately nothing else.** The Fulfilment Strategies and the migration
 * sets are already answered — by `GET /admin/fulfilment-strategies` (ADR-0067) and by
 * `GET /health` — and restating either here would be two descriptions of one fact that can
 * disagree, permanently, under ADR-0060. A screen that wants all of it composes three reads.
 *
 * It carries no identifier and reads no table. Everything it reports was decided before the
 * server listened and cannot change while the process runs, which is also why the route it
 * feeds does not page (ADR-0067).
 */

/**
 * One position in a Workflow, as this route reports it.
 *
 * The three fields are three different questions, and the last one is the reason this shape
 * exists rather than a list of names: `slot` is the position Core declared and what an override
 * map is keyed by, `step` is what the implementation filling it calls itself, and `origin` is
 * where that implementation came from. The first two agree for a Core default — **and for an
 * inserted Step, and for a replacement that reuses the slot's name**, which is why `origin`
 * cannot be derived from them and is recorded at the rewiring instead.
 */
export type DeployedStep = {
  readonly slot: string;
  readonly step: string;
  readonly origin: StepOrigin;
};

/** One declared Workflow, and every position in it in the order it runs. */
export type DeployedWorkflow = {
  readonly name: string;
  readonly steps: readonly DeployedStep[];
};

/** What `GET /admin/deployment` answers. */
export type DeploymentReport = {
  readonly version: string;
  readonly workflows: readonly DeployedWorkflow[];
  readonly payments: { readonly configured: boolean };
};

/** Everything the report is built from — all of it decided at boot, none of it a row. */
export type DeploymentFacts = {
  /**
   * The release of Core this is.
   *
   * Taken as an argument rather than read here, so that `coreVersion()` in `http/app.ts` stays
   * the one reader of Core's manifest: this route is a second reader of that *fact* and not a
   * second copy of it (ADR-0060, ADR-0080).
   */
  readonly version: string;
  /** Every declaration this deployment runs — Core's, rebuilt with whatever a Project wired. */
  readonly workflows: WorkflowRegistry;
  /** What `payments.provider` was wired with, or `undefined` for a deployment with none. */
  readonly paymentProvider: PaymentProvider | undefined;
};

/**
 * The deployment, as plain data.
 *
 * **The Workflows are in name order**, like `GET /admin/fulfilment-strategies`: the registry is
 * an object, and the order of an object's keys is not something a client should be reading a
 * list out of. The *positions* inside one keep the order they run in, because that order is the
 * whole of what a Workflow declaration says.
 *
 * **The provider is reported as a boolean and never as itself.** ADR-0053 makes it an interface
 * Core implements nowhere, so there is no name to report that is not a Project's own variable —
 * and a deployment with none is a working deployment that refuses to place an Order and nothing
 * else, which is the one fact worth answering. An object rather than a bare boolean so that
 * whatever a provider can one day say about itself arrives as a field beside `configured`,
 * which is additive under ADR-0060.
 */
export function describeDeployment(facts: DeploymentFacts): DeploymentReport {
  const workflows = Object.values(facts.workflows)
    .map((workflow) => ({
      // The Workflow's own name rather than the key it is registered under. They agree — the
      // registry is built by name in `createKobai` — and reading the declaration is the half
      // that stays true if that ever stops being how the map is assembled.
      name: workflow.name,
      steps: workflow.steps.map((position) => ({
        slot: position.slot,
        step: position.step.name,
        // Read off the position rather than compared against the slot. The comparison is wrong
        // for an inserted Step and for a replacement that reuses the slot's name, and wrong
        // silently in both cases — see `workflow/workflow.ts`.
        origin: position.origin,
      })),
    }))
    .sort(byName);

  return {
    version: facts.version,
    workflows,
    payments: { configured: facts.paymentProvider !== undefined },
  };
}

/**
 * Name order, and deliberately not `localeCompare`.
 *
 * `fulfilmentStrategyNames` answers the same question with a plain `sort()` for the same reason:
 * a locale-sensitive comparison would order one deployment's answer differently from another's
 * on a fact — the runtime's locale — that nothing in the response records.
 */
function byName(one: DeployedWorkflow, other: DeployedWorkflow): number {
  if (one.name === other.name) return 0;
  return one.name < other.name ? -1 : 1;
}
