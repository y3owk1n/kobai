import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { PriceResolutionRefusal, ResolvedPrice } from "../pricing/resolve-price.ts";
import type { WorkflowRun } from "../workflow/run.ts";

/**
 * **A Workflow run as a response** — what a refusal becomes, how its `reason` becomes a status,
 * and what a resolved price becomes.
 *
 * Both surfaces run Workflows now. The store surface has always run three — `resolve-price`,
 * the quote and the placement — and `GET /admin/variants/{id}/price` joined them when #276
 * gated the store's price route on a Product being published and the Admin's preview of a
 * *draft's* price needed a route of its own. Two copies of "what a refusal looks like" would be
 * two shapes one client meets on two paths, so there is one of each here.
 *
 * What stays with each surface is the **map** — which reason means which status — because that
 * is the part `satisfies` makes exhaustive against a particular Workflow's own union, and a
 * shared table would infer a status union covering routes that can never answer half of it. The
 * one exception is price resolution's, which is below: it is the same two words on both
 * surfaces, so a second copy could only disagree.
 */

/**
 * A refusal, in the shape every other kobai refusal uses — plus which Step refused.
 *
 * The Steps that ran are reported on the way out as well as on the way in, so a Developer
 * debugging a refused run can see how far the Workflow got before it stopped.
 */
export function workflowRefusal(
  run: Extract<WorkflowRun<unknown>, { ok: false }>,
  workflow: string,
) {
  return {
    error: run.detail,
    reason: run.reason,
    workflow: {
      name: workflow,
      failed: run.failed,
      steps: run.steps,
    },
  };
}

/** What a route answers when a Step it has never heard of refused. */
const REFUSED_BY_A_STEP_CORE_DOES_NOT_KNOW = 422;

/**
 * Turns a Workflow's map of Core's own reasons into the function a route answers with.
 *
 * One of these per Workflow, built from that Workflow's map — the *map* is what says what a
 * reason means and where `satisfies` makes forgetting one a build failure, and this is only the
 * lookup around it. The cast is what the map deliberately gives up: a `reason` arriving here is
 * a plain string, because a Step a Project or a Plugin supplied may refuse with anything, and
 * anything Core has never heard of is 422 — the request was well formed and the Workflow
 * declined it, which is the most that can honestly be said about a refusal whose meaning is not
 * Core's to know.
 */
export function statusMapper<Status extends ContentfulStatusCode>(
  statuses: Readonly<Record<string, Status>>,
): (reason: string) => Status | typeof REFUSED_BY_A_STEP_CORE_DOES_NOT_KNOW {
  return (reason) => statuses[reason] ?? REFUSED_BY_A_STEP_CORE_DOES_NOT_KNOW;
}

/**
 * The two statuses a refused resolution can carry.
 *
 * Narrow on purpose: both routes declare exactly these, so a third one would have to be
 * declared before it could be returned.
 */
export type PriceRefusalStatus = 404 | 422;

/**
 * How a refusing Step of `resolve-price` becomes a status, on **either** surface.
 *
 * Core's own reasons are mapped, and `satisfies` makes an unmapped one a build failure rather
 * than an `undefined` status. Anything else is a Step Core has never heard of — see
 * {@link statusMapper}.
 *
 * It is shared where the quote's and the placement's maps are not, and the asymmetry is the
 * point: those two belong to routes only the store surface has, while this one word-for-word
 * decides what a Merchant previewing a price and a storefront asking for one are both told. A
 * `price-not-set` that was a 404 on one surface and a 422 on the other would be the two routes
 * disagreeing about the same run.
 */
const PRICE_REFUSAL_STATUS = {
  "variant-not-found": 404,
  "price-not-set": 404,
} as const satisfies Record<PriceResolutionRefusal, PriceRefusalStatus>;

export const priceStatusFor = statusMapper<PriceRefusalStatus>(PRICE_REFUSAL_STATUS);

/**
 * A resolved price as either price route answers it — **one expression, so the two cannot
 * disagree**.
 *
 * The `workflow.steps` beside the price is what lets a Developer who replaced a Step see that
 * theirs ran (spec story 33), and a Merchant previewing an unpublished Product needs it more
 * than anybody. Written here rather than at each handler for `orderTotalOf`'s reason: "the
 * preview and the storefront agree" is worth having as a property of there being one expression,
 * not as an assertion somebody remembered to write — though
 * `catalog/a-draft-product-is-not-buyable.test.ts` asserts it from outside as well, because a
 * shared expression says nothing about the two routes having been handed the same declaration.
 */
export function resolvedPriceBody(
  run: Extract<WorkflowRun<ResolvedPrice>, { ok: true }>,
  workflow: string,
) {
  return { ...run.output, workflow: { name: workflow, steps: run.steps } };
}
