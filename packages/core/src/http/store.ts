import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requireApiKey, requireSecretApiKey, type StoreEnv } from "../auth/store-gate.ts";
import { readCart } from "../cart/read.ts";
import {
  addLineItem,
  type CartRefusal,
  createCart,
  removeLineItem,
  updateCart,
  updateLineItem,
} from "../cart/write.ts";
import type { Database } from "../db/client.ts";
import type { PlaceOrderRefusal, PlaceOrderWorkflow } from "../order/place-order.ts";
import { readOrder } from "../order/read.ts";
import type {
  PriceResolutionRefusal,
  PriceResolutionWorkflow,
} from "../pricing/resolve-price.ts";
import { openMetadata, type WorkflowRegistry } from "../workflow/context.ts";
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
 * nothing.
 *
 * **Everything here works for a guest.** Core assumes an authenticated Shopper nowhere
 * (ADR-0020): a Cart is addressed by an identifier the storefront holds, and the only
 * credential in play is the API key that opened the surface.
 */

export type StoreDependencies = {
  readonly db: Database;
  /**
   * The `resolve-price` declaration this deployment runs — Core's, or the one the Project's
   * config rebuilt by replacing a Step (ADR-0017). Handed in rather than imported, because a
   * route that imported it would run Core's Steps whatever the Project had wired.
   */
  readonly priceWorkflow: PriceResolutionWorkflow;
  /** The `place-order` declaration this deployment runs, for the same reason. */
  readonly placeOrderWorkflow: PlaceOrderWorkflow;
  /**
   * Every declaration this deployment runs, for a Step that invokes another Workflow
   * (ADR-0054).
   *
   * It goes on the context of **every** Workflow this surface runs, not only the one whose
   * Steps compose today. A route that built its context without it would hand its Steps Core's
   * own declarations whatever the Project had wired — and that failure is silent, which is why
   * it is threaded here once rather than remembered per route (#113).
   */
  readonly workflows: WorkflowRegistry;
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

// ---- Carts --------------------------------------------------------------------------------

/**
 * The refusals a Cart route may declare, and the whole of what a Cart handler may answer.
 *
 * Each route names the subset its handler can actually make, which is decided one level down:
 * `cart/write.ts` narrows each operation's `reason` to what that operation can refuse with, the
 * `StatusesFor` maps below turn exactly those reasons into statuses, and `app.openapi` types the
 * handler against the declaration. So a handler answering with a status its route never named
 * does not compile, and a route naming a status no `reason` maps to is a status nothing can
 * reach — visible as an entry with no map behind it.
 */
const CART_REFUSALS = {
  invalid: json(
    "The request does not fit this endpoint's schema, or names a value it cannot use.",
    contract.CartRefusal,
  ),
  /**
   * The one `403` on this surface a **handler** answers, and the reason it is not a gate.
   *
   * Everywhere else a `403` is `requirePermission`'s, registered through `gate-refusals.ts`
   * so that `openapi.test.ts` can hold the declaration to a chain that makes it. This one
   * cannot be middleware: it depends on whether the *body* asserts a Shopper, and a gate that
   * demanded a secret key for every Cart write would shut a browser's publishable key out of
   * building a Cart at all — which is the common storefront pattern and the thing ADR-0020
   * keeps working. It is a handler refusal like `409 sku-taken`, held to its route by the
   * `satisfies` on `CREATE_CART_STATUS` and by the compiler.
   *
   * `place-order`'s secret-key requirement is the other kind — unconditional, and therefore a
   * real gate that belongs in `GATE_REFUSALS`.
   */
  needsSecretKey: json(
    'This request asserts who the Shopper is, which needs a secret key (ADR-0020). Detaching one — `"shopper": null` — asserts nothing and does not.',
    contract.CartRefusal,
  ),
  // Three, because a 404 on these routes means three different things and a client reading
  // the description should not have to guess which of them applies to the route it is on.
  noCart: json("No such Cart exists.", contract.CartRefusal),
  noCartOrVariant: json(
    "No such Cart exists, or no such Variant does.",
    contract.CartRefusal,
  ),
  noCartOrLineItem: json(
    "No such Cart exists, or this Cart carries no such Line Item.",
    contract.CartRefusal,
  ),
  expired: json(
    "This Cart has expired. It still reads, and it can no longer be changed.",
    contract.CartRefusal,
  ),
  notSellable: json(
    "Well formed, and still refused: that Variant carries no Price.",
    contract.CartRefusal,
  ),
} as const;

const CART_BODY = "The Cart, with its Line Items.";

const createCartRoute = createRoute({
  method: "post",
  path: "/carts",
  summary: "Start a Cart",
  description:
    "Works for a guest, because Core assumes an authenticated Shopper nowhere (ADR-0020). The `id` in the answer is the whole of the authority to act on this Cart — treat it as a credential. A Shopper may be attached here, but only over a secret key.",
  security: API_KEY,
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: contract.CreateCartRequest } },
    },
  },
  responses: {
    201: json(CART_BODY, contract.Cart),
    400: CART_REFUSALS.invalid,
    401: REFUSALS.noApiKey,
    403: CART_REFUSALS.needsSecretKey,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const readCartRoute = createRoute({
  method: "get",
  path: "/carts/{id}",
  summary: "Read a Cart",
  description:
    "An expired Cart reads like any other, with `expired` true — so a storefront can say what happened rather than showing nothing, and its Line Items are still there for an abandoned-cart Plugin to find (ADR-0028).",
  security: API_KEY,
  request: { params: contract.IdParam },
  responses: {
    200: json(CART_BODY, contract.Cart),
    401: REFUSALS.noApiKey,
    404: CART_REFUSALS.noCart,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const updateCartRoute = createRoute({
  method: "patch",
  path: "/carts/{id}",
  summary: "Attach a Shopper, or change a Cart's own data",
  description:
    "What a storefront calls when a guest signs in half way through. `shopper` needs a secret key; `null` makes the Cart a guest's again.",
  security: API_KEY,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.UpdateCartRequest } },
    },
  },
  responses: {
    200: json(CART_BODY, contract.Cart),
    400: CART_REFUSALS.invalid,
    401: REFUSALS.noApiKey,
    403: CART_REFUSALS.needsSecretKey,
    404: CART_REFUSALS.noCart,
    409: CART_REFUSALS.expired,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const addLineItemRoute = createRoute({
  method: "post",
  path: "/carts/{id}/line-items",
  summary: "Add a Variant to a Cart",
  description:
    "Adding a Variant the Cart already carries raises that Line Item's quantity rather than writing a second line. A Variant with no Price is refused: a Store cannot sell what it has not priced.",
  security: API_KEY,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.AddCartLineItemRequest } },
    },
  },
  responses: {
    200: json(CART_BODY, contract.Cart),
    400: CART_REFUSALS.invalid,
    401: REFUSALS.noApiKey,
    404: CART_REFUSALS.noCartOrVariant,
    409: CART_REFUSALS.expired,
    422: CART_REFUSALS.notSellable,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const updateLineItemRoute = createRoute({
  method: "patch",
  path: "/carts/{id}/line-items/{lineItemId}",
  summary: "Change a Line Item",
  description:
    "Its quantity, its own data, or both. A quantity of zero is refused rather than treated as a removal — removing a line is `DELETE`.",
  security: API_KEY,
  request: {
    params: contract.CartLineItemParams,
    body: {
      required: true,
      content: { "application/json": { schema: contract.UpdateCartLineItemRequest } },
    },
  },
  responses: {
    200: json(CART_BODY, contract.Cart),
    400: CART_REFUSALS.invalid,
    401: REFUSALS.noApiKey,
    404: CART_REFUSALS.noCartOrLineItem,
    409: CART_REFUSALS.expired,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const removeLineItemRoute = createRoute({
  method: "delete",
  path: "/carts/{id}/line-items/{lineItemId}",
  summary: "Remove a Line Item",
  description:
    "Answers with what is left, so a storefront re-renders the Cart without a second request.",
  security: API_KEY,
  request: { params: contract.CartLineItemParams },
  responses: {
    200: json(CART_BODY, contract.Cart),
    401: REFUSALS.noApiKey,
    404: CART_REFUSALS.noCartOrLineItem,
    409: CART_REFUSALS.expired,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

// ---- Orders -------------------------------------------------------------------------------

/**
 * Placing an Order — one request, and the whole Order back.
 *
 * The `403` here is the store surface's **second gate** rather than a handler's answer, and the
 * distinction is the one `CART_REFUSALS.needsSecretKey` documents from the other side: a Cart's
 * `403` depends on whether the body asserts a Shopper, so it cannot be middleware, and this one
 * is unconditional — no request with a publishable key may place an Order, whatever it says
 * (ADR-0055). So it is a real gate, registered in `GATE_REFUSALS`, and `openapi.test.ts` holds
 * the declaration below to a chain that actually makes it.
 */
const placeOrderRoute = createRoute({
  method: "post",
  path: "/orders",
  summary: "Turn a Cart into an Order",
  middleware: [requireSecretApiKey()] as const,
  security: API_KEY,
  description:
    "Requires a **secret** key: this is where money and stock move, and a publishable key is shipped to a browser (ADR-0055). Prices are resolved now rather than read off the Cart, through the same `resolve-price` Workflow a storefront quotes with — so a Project that replaced a pricing Step charges its own prices here without wiring anything twice. The Order's Line Items hold a snapshot, so the catalog stays freely editable afterwards.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: contract.PlaceOrderRequest } },
    },
  },
  responses: {
    201: json("The Order, and the Steps that produced it.", contract.PlacedOrder),
    // The shared one, unlike a Cart route's: every refusal past the schema on this route comes
    // from a Step, so `invalid` is the only reason a body can be turned back with here and
    // there is nothing narrower to say.
    400: REFUSALS.invalid,
    401: REFUSALS.noApiKey,
    403: REFUSALS.secretKeyRequired,
    404: json("A Step refused: there is no such Cart.", contract.PlaceOrderRefusal),
    409: json(
      "A Step refused: this Cart has expired and can no longer be placed.",
      contract.PlaceOrderRefusal,
    ),
    422: json(
      "A Step refused. The request was well formed and the Workflow declined it — the Cart is empty, a line can no longer be priced, or a Step this build of Core does not know said no.",
      contract.PlaceOrderRefusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const readOrderRoute = createRoute({
  method: "get",
  path: "/orders/{id}",
  summary: "Read an Order",
  middleware: [requireSecretApiKey()] as const,
  security: API_KEY,
  description:
    "So reloading a confirmation page needs no client-side cache. A secret key, like placing one: an Order names a Shopper and what they paid, which is not a browser's to read back (ADR-0055).",
  request: { params: contract.IdParam },
  responses: {
    200: json("The Order, exactly as Capture reported it.", contract.Order),
    401: REFUSALS.noApiKey,
    403: REFUSALS.secretKeyRequired,
    404: json("No such Order exists.", contract.OrderRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

export function createStoreRoutes(deps: StoreDependencies): OpenAPIHono<StoreEnv> {
  const store = new OpenAPIHono<StoreEnv>({ defaultHook: invalidRequestHook });

  store.use("*", requireApiKey(deps.db));

  /**
   * The context a Workflow this surface runs is given.
   *
   * `metadata` is everything the caller sent that Core does not model, carried through
   * untouched — ADR-0013's open context, at the edge where it is filled. `workflows` is the
   * deployment's registry, so a Step that invokes another Workflow reaches *this* deployment's
   * declaration of it rather than Core's (ADR-0054); it is put here rather than at each call
   * site because a route that forgot it would silently ignore a Project's override (#113).
   */
  const contextFor = (c: Context<StoreEnv>) => ({
    db: deps.db,
    metadata: openMetadata(new URL(c.req.url)),
    workflows: deps.workflows,
  });

  store.openapi(resolvePriceRoute, async (c) => {
    const run = await deps.priceWorkflow.run(
      { variantId: c.req.valid("param").id },
      contextFor(c),
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

  store.openapi(createCartRoute, async (c) => {
    // `c.get("apiKey").kind` rather than a middleware: this is not a gate. Only a request that
    // *asserts a Shopper* needs a secret key, so a publishable-key storefront building an
    // ordinary Cart is the common case and must keep working (ADR-0020).
    const created = await createCart(
      deps.db,
      c.req.valid("json") ?? {},
      c.get("apiKey").kind,
    );
    if (!created.ok) return refusedCart(c, created, CREATE_CART_STATUS);
    return c.json(created.cart, 201);
  });

  store.openapi(readCartRoute, async (c) => {
    const found = await readCart(deps.db, c.req.valid("param").id);
    if (!found) return refusedCart(c, noSuchCart(), READ_CART_STATUS);
    return c.json(found, 200);
  });

  store.openapi(updateCartRoute, async (c) => {
    const updated = await updateCart(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
      c.get("apiKey").kind,
    );
    if (!updated.ok) return refusedCart(c, updated, UPDATE_CART_STATUS);
    return c.json(updated.cart, 200);
  });

  store.openapi(addLineItemRoute, async (c) => {
    const added = await addLineItem(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    if (!added.ok) return refusedCart(c, added, ADD_LINE_ITEM_STATUS);
    return c.json(added.cart, 200);
  });

  store.openapi(updateLineItemRoute, async (c) => {
    const params = c.req.valid("param");
    const changed = await updateLineItem(
      deps.db,
      params.id,
      params.lineItemId,
      c.req.valid("json"),
    );
    if (!changed.ok) return refusedCart(c, changed, UPDATE_LINE_ITEM_STATUS);
    return c.json(changed.cart, 200);
  });

  store.openapi(removeLineItemRoute, async (c) => {
    const params = c.req.valid("param");
    const removed = await removeLineItem(deps.db, params.id, params.lineItemId);
    if (!removed.ok) return refusedCart(c, removed, REMOVE_LINE_ITEM_STATUS);
    return c.json(removed.cart, 200);
  });

  store.openapi(placeOrderRoute, async (c) => {
    const run = await deps.placeOrderWorkflow.run(
      { cartId: c.req.valid("json").cartId },
      contextFor(c),
    );

    if (!run.ok)
      return c.json(
        refusal(run, deps.placeOrderWorkflow.name),
        placeOrderStatusFor(run.reason),
      );

    return c.json(
      {
        ...run.output,
        // The slots this deployment ran and what filled each, so a Project that replaced one
        // sees its own Step here — the same field, and the same reason, as a resolved price.
        workflow: { name: deps.placeOrderWorkflow.name, steps: run.steps },
      },
      201,
    );
  });

  store.openapi(readOrderRoute, async (c) => {
    const found = await readOrder(deps.db, c.req.valid("param").id);
    if (!found) {
      return c.json(
        {
          error:
            "No such Order exists. An Order is addressed by the identifier Capture reported, which is not its Order number.",
          reason: "order-not-found" as const,
        },
        404,
      );
    }
    return c.json(found, 200);
  });

  /**
   * There is deliberately no catch-all here any more.
   *
   * This surface used to carry its own wildcard answering an unrouted `/store` path as
   * `{ error, reason: "not-found" }`, because Hono's own 404 is plain text and a storefront
   * should be able to parse every answer the same way. The admin surface had no equivalent
   * (#33), so the fix was one `app.notFound` covering the whole application rather than a
   * second copy of this one — see `app.ts`. The behaviour a storefront sees is unchanged,
   * including the order: `requireApiKey` is mounted on this sub-app with `use("*")`, so it
   * still answers an anonymous caller before anything says whether the path is there.
   */

  return store;
}

/**
 * A Cart refused, in the shape every other kobai refusal uses.
 *
 * The status map is passed in rather than switched on here, so each route says what its own
 * reasons mean and the compiler asks for all of them: `satisfies Record<…>` on each map makes
 * an unmapped reason a build failure rather than an `undefined` status, and the route
 * declaring that status is the other half — a status no route names does not typecheck.
 */
function refusedCart<Reason extends CartRefusal, Status extends ContentfulStatusCode>(
  c: Context<StoreEnv>,
  refusal: { readonly reason: Reason; readonly detail: string },
  statuses: Record<Reason, Status>,
) {
  return c.json(
    { error: refusal.detail, reason: refusal.reason },
    statuses[refusal.reason],
  );
}

/**
 * The statuses one Cart operation's refusals mean, keyed to the operation itself.
 *
 * `StatusesFor<typeof createCart>` reads the reason union off the function's own return type,
 * so the map is exhaustive against what that function can actually refuse rather than against
 * a union restated here — and a Step of `cart/write.ts` that grows a reason turns the map red
 * naming it. Each map stays separate because the *route* declares only the statuses its map
 * holds: one shared table would infer a status union covering every Cart route, and every
 * route would then have to declare a `422` it can never answer.
 */
type StatusesFor<Operation extends (...args: never[]) => Promise<unknown>> = Record<
  Extract<Awaited<ReturnType<Operation>>, { ok: false }>["reason"],
  ContentfulStatusCode
>;

const CREATE_CART_STATUS = {
  invalid: 400,
  "secret-key-required": 403,
} as const satisfies StatusesFor<typeof createCart>;

const READ_CART_STATUS = { "cart-not-found": 404 } as const;

const UPDATE_CART_STATUS = {
  invalid: 400,
  "secret-key-required": 403,
  "cart-not-found": 404,
  "cart-expired": 409,
} as const satisfies StatusesFor<typeof updateCart>;

/** 422 for a Variant with no Price: well formed, and still refused. */
const ADD_LINE_ITEM_STATUS = {
  invalid: 400,
  "cart-not-found": 404,
  "cart-expired": 409,
  "variant-not-found": 404,
  "variant-not-priced": 422,
} as const satisfies StatusesFor<typeof addLineItem>;

const UPDATE_LINE_ITEM_STATUS = {
  invalid: 400,
  "cart-not-found": 404,
  "cart-expired": 409,
  "line-item-not-found": 404,
} as const satisfies StatusesFor<typeof updateLineItem>;

const REMOVE_LINE_ITEM_STATUS = {
  "cart-not-found": 404,
  "cart-expired": 409,
  "line-item-not-found": 404,
} as const satisfies StatusesFor<typeof removeLineItem>;

/**
 * Reading a Cart is the one Cart operation with no write behind it, so it is the one place the
 * refusal is written here rather than carried up from `cart/write.ts`.
 */
function noSuchCart() {
  return {
    reason: "cart-not-found",
    detail:
      "No such Cart exists. A Cart is addressed by the identifier it was created with, and holding that identifier is the whole of the authority to act on it.",
  } as const;
}

/**
 * How a refusing Step of `resolve-price` becomes a status.
 *
 * Core's own reasons are mapped, and `satisfies` makes an unmapped one a build failure rather
 * than an `undefined` status. Anything else is a Step Core has never heard of — see
 * {@link statusMapper}.
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
function statusMapper<Status extends ContentfulStatusCode>(
  statuses: Readonly<Record<string, Status>>,
): (reason: string) => Status | typeof REFUSED_BY_A_STEP_CORE_DOES_NOT_KNOW {
  return (reason) => statuses[reason] ?? REFUSED_BY_A_STEP_CORE_DOES_NOT_KNOW;
}

const statusFor = statusMapper<PriceRefusalStatus>(PRICE_REFUSAL_STATUS);

/**
 * How a Step refusing to place an Order becomes a status — the same shape, and the same
 * `satisfies`, as the price map above.
 *
 * It covers **two** unions, because two of Core's own Workflows can refuse on this path:
 * `place-order`'s own Steps, and `resolve-price`'s, whose refusals travel out of `price-lines`
 * as themselves so that a Plugin's or a Project's Step can do the same. Both are exhaustive, so
 * a new reason in either turns this red naming it rather than silently answering 422.
 *
 * A price refusal is `422` here where the price route answers `404`, and the difference is what
 * the path addresses: on `POST /orders` the thing named is the **Cart**, so a `404` would say
 * that is what is missing. A line whose Variant has since lost its Price is a well-formed
 * request the Workflow declined.
 */
const PLACE_ORDER_REFUSAL_STATUS = {
  "cart-not-found": 404,
  "cart-expired": 409,
  "cart-empty": 422,
  "variant-not-found": 422,
  "price-not-set": 422,
} as const satisfies Record<
  PlaceOrderRefusal | PriceResolutionRefusal,
  PlaceOrderRefusalStatus
>;

/** The three statuses a refused Capture can carry. The route declares exactly these. */
type PlaceOrderRefusalStatus = 404 | 409 | 422;

const placeOrderStatusFor = statusMapper<PlaceOrderRefusalStatus>(
  PLACE_ORDER_REFUSAL_STATUS,
);

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
