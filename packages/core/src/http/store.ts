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
import {
  listStoreProducts,
  readStoreProduct,
  readStoreVariant,
  type StoreCatalogRefusal,
} from "../catalog/store-read.ts";
import type { Database } from "../db/client.ts";
import { DEFAULT_PAGE_LIMIT } from "../db/page.ts";
import type { FulfilmentStrategies } from "../fulfilment/strategy.ts";
import { claimIdempotencyKey, type IdempotencyRefusal } from "../order/idempotency.ts";
import type { PlaceOrderRefusal, PlaceOrderWorkflow } from "../order/place-order.ts";
import { type Order, readOrder, readOrderPlacedFrom } from "../order/read.ts";
import type { PaymentProvider } from "../payment/provider.ts";
import type {
  PriceResolutionRefusal,
  PriceResolutionWorkflow,
} from "../pricing/resolve-price.ts";
import {
  openMetadata,
  openMetadataWithBody,
  type WorkflowRegistry,
} from "../workflow/context.ts";
import type { WorkflowRun } from "../workflow/run.ts";
import * as contract from "./contract.ts";
import {
  API_KEY,
  invalidRequestHook,
  json,
  PAGE_QUERY_INVALID,
  REFUSALS,
} from "./openapi.ts";

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
   * The Fulfilment Strategies this deployment has (ADR-0052), for the Steps that ask a
   * Variant's Strategy what it answers.
   *
   * It goes on the context of every Workflow this surface runs, exactly as `workflows` does and
   * for the same reason: a route that built its context without it would run against Core's two
   * whatever the Project had wired, and that failure is silent.
   */
  readonly fulfilment: FulfilmentStrategies;
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
  /**
   * The Payment Provider this deployment was wired with, for the Step that takes money
   * (ADR-0053).
   *
   * `undefined` is a deployment that wired none, and it reaches `take-payment` as that — the Step
   * refuses with `no-payment-provider` and nothing else on this surface is affected.
   */
  readonly paymentProvider: PaymentProvider | undefined;
};

// ---- The catalog -------------------------------------------------------------------------

/**
 * The refusals the three catalog reads may declare, and the whole of what their handlers may
 * answer.
 *
 * A 404 each, and the two are separate entries for the reason the Cart's three are: a client
 * reading the description of `GET /store/variants/{id}` should be told that a 404 there means
 * the Variant, without having to work out which of two nouns the shared prose meant.
 */
const STORE_CATALOG_REFUSALS = {
  noProduct: json("No such Product exists.", contract.StoreCatalogRefusal),
  noVariant: json("No such Variant exists.", contract.StoreCatalogRefusal),
} as const;

/**
 * The bodies those two 404s carry, written once each.
 *
 * A table rather than an object built inside each handler, for the reason every other refusal
 * map on this surface is one: `satisfies` holds the keys to what `catalog/store-read.ts` says
 * these reads can refuse with, so a reason renamed there turns this red naming the word, and a
 * reason with no entry does not compile. The prose is `error` and is promised to nobody
 * (ADR-0060); the `reason` beside it is.
 */
const STORE_CATALOG_NOT_FOUND = {
  product: {
    error:
      "No such Product exists. A Product is addressed by the identifier `GET /store/products` reports, and one taken out of the catalog is gone from here too.",
    reason: "product-not-found",
  },
  variant: {
    error:
      "No such Variant exists. A Variant is addressed by the identifier its Product reports, which is also the `variantId` a Cart line carries.",
    reason: "variant-not-found",
  },
} as const satisfies Record<string, { error: string; reason: StoreCatalogRefusal }>;

/**
 * The catalog a storefront can read — the three routes a product page is built from.
 *
 * They answer {@link contract.StoreProduct} and friends rather than the admin surface's
 * `Product`, which is the load-bearing decision of this surface and is argued where those
 * schemas are declared: a publishable key is shipped to a browser, so a field a Merchant needs
 * must not be published by the deploy that adds it. What is dropped and why is in
 * `catalog/store-read.ts`.
 *
 * **A publishable key is enough**, and no route here declares a 403. ADR-0055's secret-key
 * requirement is about placing an Order and reading one back — where money moves and where the
 * answer names a Shopper. These are reads of what the Store sells, which is what a browser is
 * for.
 */
const listStoreProductsRoute = createRoute({
  method: "get",
  path: "/products",
  summary: "List what the Store sells",
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time. Ask for more with \`limit\`, and for what follows a page with the \`nextCursor\` it answered — \`nextCursor\` is absent on the last page, and that absence is the only end-of-list signal (ADR-0064). A Product carries no Variants here: open one for those. What each Variant costs is \`GET /store/variants/{id}/price\`, because a Price is resolved by a Workflow rather than read off a row.`,
  security: API_KEY,
  request: { query: contract.pageQuery("store-products") },
  responses: {
    200: json("A page of Products.", contract.StoreProductList),
    400: PAGE_QUERY_INVALID,
    401: REFUSALS.noApiKey,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const readStoreProductRoute = createRoute({
  method: "get",
  path: "/products/{id}",
  summary: "Read a Product",
  description:
    "One Product with its Variants, so a product page is one request rather than one per Variant. A Variant carries no Price and no stock count: ask `GET /store/variants/{id}/price` for the first, and ADR-0018 makes the second a conditional write rather than a readable fact.",
  security: API_KEY,
  request: { params: contract.IdParam },
  responses: {
    200: json(
      "The Product, with the Variants a Shopper chooses between.",
      contract.StoreProductDetail,
    ),
    401: REFUSALS.noApiKey,
    404: STORE_CATALOG_REFUSALS.noProduct,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const readStoreVariantRoute = createRoute({
  method: "get",
  path: "/variants/{id}",
  summary: "Read a Variant",
  description:
    "The Variant a Cart line names, without its Product. What a storefront rebuilding a Cart line asks: a line carries a `variantId` and nothing else, and fetching the whole Product to render one row is a request for everything else that Product sells.",
  security: API_KEY,
  request: { params: contract.IdParam },
  responses: {
    200: json("The Variant.", contract.StoreVariant),
    401: REFUSALS.noApiKey,
    404: STORE_CATALOG_REFUSALS.noVariant,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

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
  notChangeable: json(
    "This Cart can no longer be changed: it has expired, or it has already been placed. It still reads either way.",
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
    409: CART_REFUSALS.notChangeable,
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
    409: CART_REFUSALS.notChangeable,
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
    409: CART_REFUSALS.notChangeable,
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
    409: CART_REFUSALS.notChangeable,
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
 *
 * **Two success statuses, and the difference between them is whether anything was created.**
 * `201` is a placement; `200` is a retry carrying the idempotency key of one — the same Order,
 * without the account of a Workflow run that did not happen this time (#102).
 */
const placeOrderRoute = createRoute({
  method: "post",
  path: "/orders",
  summary: "Turn a Cart into an Order",
  middleware: [requireSecretApiKey()] as const,
  security: API_KEY,
  description:
    "Requires a **secret** key: this is where money and stock move, and a publishable key is shipped to a browser (ADR-0055). Prices are resolved now rather than read off the Cart, through the same `resolve-price` Workflow a storefront quotes with — so a Project that replaced a pricing Step charges its own prices here without wiring anything twice. The Order's Line Items hold a snapshot, so the catalog stays freely editable afterwards. Send an `Idempotency-Key` so that retrying after a timeout answers with the Order already placed rather than placing a second one; a Cart becomes exactly one Order either way.",
  request: {
    headers: contract.IdempotencyKeyHeader,
    body: {
      required: true,
      content: { "application/json": { schema: contract.PlaceOrderRequest } },
    },
  },
  responses: {
    200: json(
      "This idempotency key has already placed an Order, and this is that Order — nothing was placed again. There is no `workflow` here, because which Steps ran is a fact about the request that placed it.",
      contract.Order,
    ),
    201: json("The Order, and the Steps that produced it.", contract.PlacedOrder),
    // Its own schema rather than the shared one, and a closed `reason` because both of these
    // are Core's own: everything past them comes from a Step and is answered further down, so
    // these are the only two ways a body is turned back here and a client can tell them apart.
    400: json(
      "The request does not fit this endpoint's schema, or a key arrived in both the query string and `metadata`.",
      contract.PlaceOrderRequestRefusal,
    ),
    401: REFUSALS.noApiKey,
    402: json(
      "The Payment Provider declined. No Order exists — money is taken before Capture precisely so that a refused card leaves nothing in the Merchant's books — and `error` carries whatever the provider said for itself.",
      contract.PlaceOrderRefusal,
    ),
    403: REFUSALS.secretKeyRequired,
    404: json("A Step refused: there is no such Cart.", contract.PlaceOrderRefusal),
    409: json(
      "Nothing was placed, and this request is not the way to place it. Either the Cart can no longer produce an Order — it has expired, or it has already been placed, and a Cart becomes exactly one Order — or the Store has not got enough of something in it left to sell, or this deployment has no Payment Provider configured, or something in the Cart names a Fulfilment Strategy this deployment no longer has wired, or the idempotency key names a different request, or one still in flight.",
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
   * untouched — ADR-0013's open context, already assembled by the route from the halves the
   * request carried, because a route that takes a body has one more of them and a refusal to
   * make (#121). `workflows` is the deployment's registry, so a Step that invokes another
   * Workflow reaches *this* deployment's declaration of it rather than Core's (ADR-0054); it is
   * put here rather than at each call site because a route that forgot it would silently ignore
   * a Project's override (#113).
   */
  const contextFor = (metadata: Readonly<Record<string, unknown>>) => ({
    db: deps.db,
    metadata,
    workflows: deps.workflows,
    paymentProvider: deps.paymentProvider,
    fulfilment: deps.fulfilment,
  });

  store.openapi(listStoreProductsRoute, async (c) => {
    const page = await listStoreProducts(deps.db, c.req.valid("query"));
    // `undefined` rather than `null`, and `JSON.stringify` drops the key — the wire shape
    // ADR-0064 asks for: absent means there is no further page.
    return c.json({ products: page.items, nextCursor: page.nextCursor }, 200);
  });

  store.openapi(readStoreProductRoute, async (c) => {
    const found = await readStoreProduct(deps.db, c.req.valid("param").id);
    if (!found) return c.json(STORE_CATALOG_NOT_FOUND.product, 404);
    return c.json(found, 200);
  });

  store.openapi(readStoreVariantRoute, async (c) => {
    const found = await readStoreVariant(deps.db, c.req.valid("param").id);
    if (!found) return c.json(STORE_CATALOG_NOT_FOUND.variant, 404);
    return c.json(found, 200);
  });

  store.openapi(resolvePriceRoute, async (c) => {
    const run = await deps.priceWorkflow.run(
      { variantId: c.req.valid("param").id },
      // The query string is the whole of it: this route takes no body, so there is no second
      // half to merge and nothing that could arrive in both.
      contextFor(openMetadata(new URL(c.req.url))),
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
    const body = c.req.valid("json");

    // Both halves of the open context, or the keys that arrived in both (#121). Asked first of
    // all, ahead of the idempotency key: this is a malformed request rather than an attempt at
    // a purchase, and claiming a key for it would spend the storefront's one safe retry on a
    // request that never reached the Cart.
    const open = openMetadataWithBody(new URL(c.req.url), body.metadata);
    if (!open.ok) {
      return c.json(
        {
          error: `${open.collided.map((key) => JSON.stringify(key)).join(", ")} arrived in both the query string and \`metadata\`, and kobai reads no key out of either — so it cannot know which one this deployment's Steps meant. Send each key in one place.`,
          reason: "metadata-in-both" as const,
        },
        400,
      );
    }

    // Claimed before the Workflow runs, so a retry of a request that is still being served
    // never reaches the Cart at all — and released below unless an Order comes of it, because
    // a key standing for a purchase that never happened would refuse the retry that fixes it.
    const claim = await claimIdempotencyKey(
      deps.db,
      c.req.valid("header")["idempotency-key"],
      body,
    );
    if (claim.outcome === "replayed") return c.json(claim.order, 200);
    if (claim.outcome === "refused") {
      // A key in flight may belong to a request that captured and then died before it could
      // name its Order — the Order is the record, so ask it rather than the key. It also means
      // the loser of a race is handed the Order the moment the winner commits, instead of being
      // told to try again for a request that is already done.
      const placed =
        claim.reason === "idempotency-key-in-progress"
          ? await readOrderPlacedFrom(deps.db, body.cartId)
          : undefined;
      if (placed) return c.json(placed, 200);

      return c.json(
        { error: claim.detail, reason: claim.reason },
        IDEMPOTENCY_REFUSAL_STATUS[claim.reason],
      );
    }

    let run: WorkflowRun<Order>;
    try {
      run = await deps.placeOrderWorkflow.run(
        { cartId: body.cartId },
        contextFor(open.metadata),
      );
    } catch (bug) {
      // A Step threw. The key goes back for the same reason a refusal returns it — nothing was
      // placed — and the bug travels on as the 500 it is.
      await claim.release();
      throw bug;
    }

    if (!run.ok) {
      await claim.release();
      return c.json(
        refusal(run, deps.placeOrderWorkflow.name),
        placeOrderStatusFor(run.reason),
      );
    }

    // After Capture, never before: until the Order exists there is nothing for the key to
    // name, and a key completed early would answer a retry with an Order that is not there.
    await claim.complete(run.output.id);

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

/**
 * The refusals **every** Cart mutation can make, because `mutate` makes them before the
 * operation's own work: there is no such Cart, or there is and it can no longer be changed.
 *
 * Spread into each map below rather than written out in all four, so the next state that freezes
 * a Cart is one edit here instead of four that have to agree. It is a *part* of each map and not
 * a shared table, which is the distinction the note above draws: each route still declares
 * exactly the statuses its own map holds, and `satisfies` still holds each map to the reasons
 * that operation can actually produce.
 */
const NOT_CHANGEABLE_STATUS = {
  "cart-not-found": 404,
  "cart-expired": 409,
  "cart-placed": 409,
} as const;

const UPDATE_CART_STATUS = {
  ...NOT_CHANGEABLE_STATUS,
  invalid: 400,
  "secret-key-required": 403,
} as const satisfies StatusesFor<typeof updateCart>;

/** 422 for a Variant with no Price: well formed, and still refused. */
const ADD_LINE_ITEM_STATUS = {
  ...NOT_CHANGEABLE_STATUS,
  invalid: 400,
  "variant-not-found": 404,
  "variant-not-priced": 422,
} as const satisfies StatusesFor<typeof addLineItem>;

const UPDATE_LINE_ITEM_STATUS = {
  ...NOT_CHANGEABLE_STATUS,
  invalid: 400,
  "line-item-not-found": 404,
} as const satisfies StatusesFor<typeof updateLineItem>;

const REMOVE_LINE_ITEM_STATUS = {
  ...NOT_CHANGEABLE_STATUS,
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
  "cart-placed": 409,
  "cart-empty": 422,
  // 409 beside the Cart that can no longer be placed, and for the same reason: the request was
  // fine and the state of the Store refuses it, and retrying the same request changes nothing
  // until somebody restocks — or until a hold somebody else is holding lapses.
  "insufficient-inventory": 409,
  "variant-not-found": 422,
  "price-not-set": 422,
  // 402 is the one status on this surface that means "the money did not move", and it is the
  // only thing it means: the request was fine, the Cart was fine, and the provider said no.
  "payment-declined": 402,
  // A deployment with no Payment Provider is a conflict with the state of this Store rather than
  // a fault in the request — 409 beside the Cart that can no longer be placed, because in both
  // cases retrying the same request changes nothing until somebody changes the Store. It is not
  // a 503: everything else here is serving, and kobai ships no provider by decision (ADR-0053),
  // so this is a deployment that has not finished being configured rather than one that is down.
  "no-payment-provider": 409,
  // 409 beside it, and for the same reason: a Variant whose Fulfilment Strategy this deployment
  // no longer has is a Store that has been reconfigured out from under its own catalog, and
  // retrying changes nothing until somebody wires it back (ADR-0052).
  "unknown-fulfilment-strategy": 409,
} as const satisfies Record<
  PlaceOrderRefusal | PriceResolutionRefusal,
  PlaceOrderRefusalStatus
>;

/** The four statuses a refused Capture can carry. The route declares exactly these. */
type PlaceOrderRefusalStatus = 402 | 404 | 409 | 422;

const placeOrderStatusFor = statusMapper<PlaceOrderRefusalStatus>(
  PLACE_ORDER_REFUSAL_STATUS,
);

/**
 * What an idempotency key turns a request back with — a map of its own, and mapped for the same
 * reason every other refusal here is.
 *
 * These are made *before* the Workflow runs, so they are not in
 * {@link PLACE_ORDER_REFUSAL_STATUS} and could not be: nothing refused, and there is no slot to
 * name. What they share with it is the `satisfies`, which is the part that matters — a third way
 * a key can turn a request back has no entry here and does not compile, rather than being
 * answered 409 because 409 is what the line above happened to say.
 *
 * Both are `409` today and that is a coincidence of meaning rather than a shortcut: a key used
 * for something else and a key still in flight are both "this request conflicts with one that
 * came first", and they are told apart by `reason`.
 */
const IDEMPOTENCY_REFUSAL_STATUS = {
  "idempotency-key-reused": 409,
  "idempotency-key-in-progress": 409,
} as const satisfies Record<IdempotencyRefusal, PlaceOrderRefusalStatus>;

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
