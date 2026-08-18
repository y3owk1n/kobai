import type { Database } from "../db/client.ts";
import type { FulfilmentStrategies } from "../fulfilment/strategy.ts";
import type { PaymentProvider } from "../payment/provider.ts";
import type { AnyWorkflow } from "./workflow.ts";

/**
 * The Workflow declarations one deployment runs, by name (ADR-0054).
 *
 * A Step that invokes another Workflow names Core's exported declaration, because that is the
 * only one it can import; what has to *run* is the deployment's version of it, rebuilt from
 * whatever the Project replaced or inserted. This map is how the second is found from the
 * first, so an override written once applies everywhere that Workflow is reached — including
 * from inside another one.
 *
 * Keyed by the declaration's own `name`, and it holds **that** Workflow: putting some other
 * Workflow under a name is a lie no compiler here can see, and `runWorkflow` would run it.
 * Core builds this at boot from its own declarations, which is why nothing on the promised
 * surface hands a Project a way to assemble a dishonest one.
 */
export type WorkflowRegistry = Readonly<Record<string, AnyWorkflow>>;

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
  /**
   * The declarations this deployment runs, for a Step that invokes another Workflow — read
   * by `runWorkflow` and by nothing else (ADR-0054).
   *
   * Optional, and absent is a working answer rather than a broken one: `runWorkflow` then
   * runs the declaration it was handed. That is right for a Workflow assembled in a test and
   * wrong for a deployment, which is why whatever builds a context for a request fills it
   * from the registry `createKobai` publishes as `Kobai.workflows`.
   */
  readonly workflows?: WorkflowRegistry;
  /**
   * The Payment Provider this deployment was wired with, for the Step that takes money
   * (ADR-0053).
   *
   * It reaches a Step the way the database does — on the context — because a Step is a
   * module-level declaration a Project may replace, so there is nothing to hand a dependency to
   * at construction time. It is threaded from `createKobai` through whatever builds a context
   * for a request, exactly as `workflows` is.
   *
   * **Optional, and absent is a configuration rather than a fault.** Core ships no provider and
   * a deployment is free to wire none, so `take-payment` refuses with `no-payment-provider`
   * rather than raising — see `order/place-order.ts`.
   */
  readonly paymentProvider?: PaymentProvider;
  /**
   * The Fulfilment Strategies this deployment was wired with, for the Step that asks each line
   * what it is (ADR-0052).
   *
   * It reaches a Step the way the database and the Payment Provider do, and for the same
   * reason: a Step is a module-level declaration a Project may replace, so there is nothing to
   * hand a dependency to at construction time.
   *
   * **Optional, and absent means Core's own two** rather than none — `physical` and `digital`
   * are what a deployment that wired nothing has, so a context assembled without this key
   * behaves as that deployment does rather than as one where no Variant can be fulfilled.
   */
  readonly fulfilment?: FulfilmentStrategies;
};

/**
 * The open half of a context, read off a request's query string.
 *
 * This is ADR-0013's openness made real at the edge rather than only in the types. The
 * store surface's price route models nothing in the query string — the Variant is in the
 * path — so every parameter here is by definition something Core has never heard of, and it
 * is carried through verbatim for a Project's Step to read. Lead-time pricing is the case
 * that ADR names, and it must be reachable *without changing Core*: if a Developer had to
 * add a parameter to a Core route to get their own input to their own Step, the extension
 * surface would be wrong.
 *
 * Values arrive as strings and are not parsed, because parsing implies a shape and Core has
 * no business having an opinion about the shape of an input it does not model. A repeated
 * parameter keeps its last value — an array for some keys and a string for others would be a
 * shape too.
 *
 * A route that one day *does* model a query parameter must take it out of what it passes
 * here, or Core would start reading a key out of the open half and the openness would
 * quietly become a schema.
 */
export function openMetadata(url: URL): Record<string, unknown> {
  return Object.fromEntries(url.searchParams);
}
