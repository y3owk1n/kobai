import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { requireApiKey, type StoreEnv } from "../auth/store-gate.ts";
import type { Database } from "../db/client.ts";
import type {
  PriceResolutionRefusal,
  PriceResolutionWorkflow,
} from "../pricing/resolve-price.ts";
import { openMetadata } from "../workflow/context.ts";
import type { WorkflowRun } from "../workflow/run.ts";
import * as contract from "./contract.ts";
import { API_KEY, invalidRequestHook, json, REFUSALS } from "./openapi.ts";

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
  /**
   * The `resolve-price` declaration this deployment runs — Core's, or the one the Project's
   * config rebuilt by replacing a Step (ADR-0017). Handed in rather than imported, because a
   * route that imported it would run Core's Steps whatever the Project had wired.
   */
  readonly priceWorkflow: PriceResolutionWorkflow;
};

/**
 * What a Variant costs.
 *
 * The answer is produced by the `resolve-price` Workflow rather than by a query here, and
 * the response says which Steps ran. That field is a requirement rather than a debugging
 * nicety: it is what lets a Developer who has replaced a Step *see* that theirs ran, so the
 * extension mechanism is demonstrated rather than assumed (spec story 33).
 */
const resolvePriceRoute = createRoute({
  method: "get",
  path: "/variants/{id}/price",
  summary: "What a Variant costs",
  description:
    "Produced by the `resolve-price` Workflow. The response names the Steps that ran, so a Developer who replaced one can see that theirs did.",
  security: API_KEY,
  request: { params: contract.IdParam },
  responses: {
    200: json(
      "The resolved Price, and the Steps that produced it.",
      contract.ResolvedPrice,
    ),
    401: REFUSALS.noApiKey,
    404: json(
      "A Step refused: there is no such Variant, or it carries no Price.",
      contract.PriceRefusal,
    ),
    422: json(
      "A Step this build of Core does not know refused. The request was well formed and the Workflow declined it.",
      contract.PriceRefusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

export function createStoreRoutes(deps: StoreDependencies): OpenAPIHono<StoreEnv> {
  const store = new OpenAPIHono<StoreEnv>({ defaultHook: invalidRequestHook });

  store.use("*", requireApiKey(deps.db));

  store.openapi(resolvePriceRoute, async (c) => {
    const run = await deps.priceWorkflow.run(
      { variantId: c.req.valid("param").id },
      // Everything the caller sent that Core does not model, carried through untouched —
      // ADR-0013's open context, at the edge where it is filled.
      { db: deps.db, metadata: openMetadata(new URL(c.req.url)) },
    );

    if (!run.ok)
      return c.json(refusal(run, deps.priceWorkflow.name), statusFor(run.reason));

    return c.json(
      {
        ...run.output,
        // `steps` names each slot *and* what filled it, so a Project that replaced one sees
        // its own Step here in place of Core's.
        workflow: { name: deps.priceWorkflow.name, steps: run.steps },
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
   *
   * It is a wildcard rather than a route, so it is deliberately absent from the OpenAPI
   * description: a description enumerates the paths that exist, and this one answers the
   * paths that do not. A generated client therefore has no type for this body, which is
   * consistent rather than a gap — it also has no way to make the call that produces one.
   */
  store.all("*", (c) =>
    c.json(
      {
        error: `There is no ${c.req.path} on the store surface.`,
        reason: "not-found" as const,
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
const PRICE_REFUSAL_STATUS = {
  "variant-not-found": 404,
  "price-not-set": 404,
} as const satisfies Record<PriceResolutionRefusal, PriceRefusalStatus>;

/**
 * The two statuses a refused resolution can carry.
 *
 * Narrow on purpose: the route declares exactly these, so a third one would have to be
 * declared before it could be returned.
 */
type PriceRefusalStatus = 404 | 422;

const REFUSED_BY_A_STEP_CORE_DOES_NOT_KNOW = 422;

function statusFor(reason: string): PriceRefusalStatus {
  return (
    (PRICE_REFUSAL_STATUS as Record<string, PriceRefusalStatus>)[reason] ??
    REFUSED_BY_A_STEP_CORE_DOES_NOT_KNOW
  );
}

/**
 * A refusal, in the shape every other kobai refusal uses — plus which Step refused.
 *
 * The Steps that ran are reported on the way out as well as on the way in, so a Developer
 * debugging a refused resolution can see how far the Workflow got before it stopped.
 */
function refusal(run: Extract<WorkflowRun<unknown>, { ok: false }>, workflow: string) {
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
