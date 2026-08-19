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
  /**
   * How long this deployment holds a Cart's stock, for the Step that claims it (ADR-0075).
   *
   * It reaches a Step the way the database, the Payment Provider and the Strategies do, and
   * for the same reason: a Step is a module-level declaration a Project may replace, so there
   * is nothing to hand a dependency to at construction time.
   *
   * **Optional, and absent means Core's fifteen minutes** rather than no window at all — a
   * context assembled without this key behaves as a deployment that configured nothing does,
   * which is what a Workflow put together in a test wants and is exactly wrong for a
   * deployment. Whatever builds a context for a request fills it from what `createKobai`
   * resolved.
   */
  readonly holdWindowMs?: number;
};

/**
 * What {@link openMetadataWithBody} answers: both halves of an open context assembled, or the
 * keys that arrived in both (#121).
 *
 * A union rather than a merge and a separate check, because the two must not come apart: a
 * caller that forgot to ask about the collision would be back to Core silently choosing which
 * half a Step reads, which is the whole thing the refusal exists to prevent.
 *
 * `collided` is sorted, so the same mistake reads the same way twice.
 */
export type OpenMetadataResult =
  | { readonly ok: true; readonly metadata: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly collided: readonly string[] };

/**
 * The open half of a context as a request's **query string** carries it.
 *
 * This is ADR-0013's openness made real at the edge rather than only in the types. Core models
 * nothing in a store route's query string — a route's own inputs are on its path and in its
 * body, and both are named on its schema — so every parameter here is by definition something
 * Core has never heard of, and it is carried through verbatim for a Project's or a Plugin's
 * Step to read. Lead-time pricing is the case that ADR names, and it must be reachable
 * *without changing Core*: if a Developer had to add a parameter to a Core route to get their
 * own input to their own Step, the extension surface would be wrong.
 *
 * Values arrive as strings and are not parsed, because parsing implies a shape and Core has
 * no business having an opinion about the shape of an input it does not model. A repeated
 * parameter keeps its last value — an array for some keys and a string for others would be a
 * shape too.
 *
 * This is the whole of the open context for a route that takes **no body**, which cannot grow
 * one and so can never collide; a route that takes one reaches for
 * {@link openMetadataWithBody} instead.
 *
 * A route that one day *does* model a query parameter must take it out of what it passes
 * here, or Core would start reading a key out of the open half and the openness would
 * quietly become a schema.
 */
export function openMetadata(url: URL): Readonly<Record<string, unknown>> {
  return Object.fromEntries(url.searchParams);
}

/**
 * Both halves of the open context of a request that carries a body — its query string and the
 * `metadata` object on that body — or the keys that arrived in both (#121).
 *
 * **Two ways in, because the query string cannot do the whole job.** A lead time or a customer
 * tier is fine in a URL; a card token is not, because a query parameter is written to access
 * logs, to proxy logs and into the `Referer` of anything a confirmation page loads — a
 * credential in one has already leaked, which is what a `PaymentProvider` reading its own key
 * out of this context made urgent (ADR-0053). The body also carries the types a query string
 * has no way to spell: a number stays a number, and a nested object stays nested. It arrives as
 * whatever JSON it was written as, unparsed and untouched, for the same reason the query half
 * arrives as strings — the caller chose the shape and Core has no opinion about it.
 *
 * **A key in both halves is refused, and neither half wins.** Core cannot choose for the Step,
 * because it has never heard of the key: any precedence rule would be Core forming an opinion
 * about an input it does not model, and a Step reading a value that silently came from the
 * other place is exactly the bug worth being loud about. Two things follow, and both are
 * decisions rather than details. The check is on **names and never on values** — refusing only
 * when the two disagree would make the answer depend on what the caller sent, so one
 * storefront's bug would be served today and refused tomorrow. And refusing keeps the decision
 * open: a refusal can become body-wins or query-wins later without breaking a caller that works
 * today, where neither of those could become a refusal.
 *
 * `undefined` is a caller that sent no `metadata` at all, which is every storefront that has
 * never heard of this — the query half is the answer, exactly as it was.
 */
export function openMetadataWithBody(
  url: URL,
  body: Readonly<Record<string, unknown>> | undefined,
): OpenMetadataResult {
  const query = openMetadata(url);
  if (body === undefined) return { ok: true, metadata: query };

  const collided = Object.keys(body)
    .filter((key) => Object.hasOwn(query, key))
    .sort();
  if (collided.length > 0) return { ok: false, collided };

  return { ok: true, metadata: { ...query, ...body } };
}
