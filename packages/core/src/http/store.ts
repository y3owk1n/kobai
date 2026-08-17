import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireApiKey, type StoreEnv } from "../auth/store-gate.ts";
import type { Database } from "../db/client.ts";
import {
  type PriceResolutionRefusal,
  priceResolutionWorkflow,
} from "../pricing/resolve-price.ts";
import { openMetadata } from "../workflow/context.ts";
import type { WorkflowRun } from "../workflow/run.ts";

/**
 * The store surface — what a storefront calls, and the second of kobai's two authenticated
 * surfaces (ADR-0020).
 *
 * It is one sub-app carrying `requireApiKey`, so a route added here is authenticated by
 * construction and the surface is closed by default. There is no Merchant-only capability on
 * it and there is not going to be one: everything a Merchant does lives under `/admin`,
 * behind a session, and a key opens none of it.
 *
 * kobai is headless (ADR-0002), so this surface answers a storefront's questions and renders
 * nothing. Today it answers exactly one.
 */

export type StoreDependencies = {
  readonly db: Database;
};

export function createStoreRoutes(deps: StoreDependencies): Hono<StoreEnv> {
  const store = new Hono<StoreEnv>();

  store.use("*", requireApiKey(deps.db));

  /**
   * What a Variant costs.
   *
   * The answer is produced by the `resolve-price` Workflow rather than by a query here, and
   * the response says which Steps ran. That field is a requirement rather than a debugging
   * nicety: it is what lets a Developer who has replaced a Step *see* that theirs ran, so the
   * extension mechanism is demonstrated rather than asserted (spec story 33).
   */
  store.get("/variants/:id/price", async (c) => {
    const run = await priceResolutionWorkflow.run(
      { variantId: c.req.param("id") },
      // Everything the caller sent that Core does not model, carried through untouched —
      // ADR-0013's open context, at the edge where it is filled.
      { db: deps.db, metadata: openMetadata(new URL(c.req.url)) },
    );

    if (!run.ok) return c.json(refusal(run), statusFor(run.reason));

    return c.json(
      {
        ...run.output,
        workflow: { name: priceResolutionWorkflow.name, steps: run.steps },
      },
      200,
    );
  });

  /**
   * Anything else under `/store`.
   *
   * Registered last, so it answers only what no route above did. It exists because Hono's
   * own 404 is plain text, and a storefront should be able to parse every answer this
   * surface gives the same way — including the ones it did not expect. A request with the
   * right path and the wrong method lands here too, and is reported as a path that is not
   * there; distinguishing the two would mean enumerating methods per path for a surface that
   * currently has one route.
   */
  store.all("*", (c) =>
    c.json(
      {
        error: `There is no ${c.req.path} on the store surface.`,
        reason: "not-found",
      },
      404,
    ),
  );

  return store;
}

/**
 * How a refusing Step becomes a status.
 *
 * Core's own reasons are mapped, and `satisfies` makes an unmapped one a build failure
 * rather than an `undefined` status. Anything else came from a Step this Core version has
 * never heard of — a Project's or a Plugin's — and answers 422: the request was well formed
 * and the Workflow declined it, which is the most that can honestly be said about a refusal
 * whose meaning is not Core's to know.
 */
const REFUSED = {
  "variant-not-found": 404,
  "price-not-set": 404,
} as const satisfies Record<PriceResolutionRefusal, ContentfulStatusCode>;

const REFUSED_BY_A_STEP_CORE_DOES_NOT_KNOW = 422;

function statusFor(reason: string): ContentfulStatusCode {
  return (
    (REFUSED as Record<string, ContentfulStatusCode>)[reason] ??
    REFUSED_BY_A_STEP_CORE_DOES_NOT_KNOW
  );
}

/**
 * A refusal, in the shape every other kobai refusal uses — plus which Step refused.
 *
 * The Steps that ran are reported on the way out as well as on the way in, so a Developer
 * debugging a refused resolution can see how far the Workflow got before it stopped.
 */
function refusal(run: Extract<WorkflowRun<unknown>, { ok: false }>) {
  return {
    error: run.detail,
    reason: run.reason,
    workflow: {
      name: priceResolutionWorkflow.name,
      failed: run.failed,
      steps: run.steps,
    },
  };
}
