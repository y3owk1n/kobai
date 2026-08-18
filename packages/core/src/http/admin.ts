import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type ApiKeyCreation,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../auth/api-key.ts";
import {
  type AdminEnv,
  authenticated,
  requirePermission,
  requireSession,
} from "../auth/gate.ts";
import type { MerchantIdentity, RoleSummary } from "../auth/identity.ts";
import {
  authenticateMerchant,
  createMerchant,
  type MerchantCreation,
} from "../auth/merchant.ts";
import { PERMISSIONS } from "../auth/permissions.ts";
import { createSession, revokeSession, type SessionPolicy } from "../auth/session.ts";
import {
  clearedSessionCookie,
  type Scheme,
  schemeOf,
  sessionCookie,
} from "../auth/session-cookie.ts";
import {
  deletePrice,
  deleteProduct,
  deleteVariant,
  type PriceDeletion,
  type ProductDeletion,
  type VariantDeletion,
} from "../catalog/delete.ts";
import { listProducts, readProduct } from "../catalog/read.ts";
import {
  createProduct,
  type PriceCreation,
  type ProductCreation,
  setPrice,
} from "../catalog/write.ts";
import type { Database } from "../db/client.ts";
import type { FulfilmentStrategies } from "../fulfilment/strategy.ts";
import { listOrders, readOrder } from "../order/read.ts";
import { type InventoryUpdate, setInventory } from "../reservation/inventory.ts";
import { readStore } from "../store/read.ts";
import * as contract from "./contract.ts";
import { invalidRequestHook, json, MERCHANT_SESSION, REFUSALS } from "./openapi.ts";

/**
 * The admin surface — everything a Merchant reaches, and the only thing the Admin consumes
 * (ADR-0010). There is no privileged back door here for it to use instead.
 *
 * It is in two halves, and the split is the security property:
 *
 * - **the way in** — one route, `POST /admin/session`, which cannot require a session
 *   because it is what mints one;
 * - **everything else**, on a sub-app carrying `requireSession`, so a route added there is
 *   authenticated by construction and each route names the one permission it needs.
 *
 * Registration order matters — the way in is registered first, so its handler answers before
 * the guard below it is reached. That first half is deliberately as small as it can be: it
 * held `POST /admin/merchants` too until #25, so that the first Merchant could be created
 * anonymously, and **there is now no unauthenticated write path anywhere under `/admin`**.
 * The first Merchant is seeded at boot instead (`auth/seed.ts`).
 * `auth.test.ts` sweeps every operation the description carries and calls it with no cookie,
 * so a route added to the wrong half fails the build rather than opening the surface.
 *
 * **Every route is a declaration.** A route is a `createRoute({…})` object naming its path,
 * its security scheme, the body it takes and every status it answers with, and
 * `app.openapi(route, handler)` is what both serves it and puts it in the description. So
 * the description is not a document beside the code that somebody keeps up to date: it is
 * the code. A response the description promises and the handler does not produce does not
 * ship, because `c.json(body, status)` is typed against the schema the route declared.
 */

export type AdminDependencies = {
  readonly db: Database;
  /**
   * The Fulfilment Strategies this deployment has (ADR-0052), for the one route that creates
   * Variants — a Variant may only point at a Strategy the Project actually wired.
   */
  readonly fulfilment: FulfilmentStrategies;
  /**
   * How long this deployment's sessions live (ADR-0050). The gate below enforces it, and the
   * two routes that answer with a `Session` describe it — which is why those two are declared
   * per instance and every other route on this surface is a module-level constant.
   */
  readonly sessionPolicy: SessionPolicy;
};

// ---- The way in --------------------------------------------------------------------------

/**
 * Signs in: exchanges credentials for a session.
 *
 * A function of the schema rather than a constant, because `Session` carries this
 * deployment's own idle window in its description (`contract.sessionSchema`). The route is
 * still one declaration in one place; it is just built when the app is, like the gate.
 */
const signInRoute = (Session: contract.SessionSchema) =>
  createRoute({
    method: "post",
    path: "/session",
    summary: "Sign in",
    description:
      "The session travels back as an httpOnly `kobai_session` cookie, which a browser then sends on every admin request by itself; it is in no response body. An unknown address and a wrong password are answered identically, and in the same time — distinguishing them would turn this into a way to ask who works here.",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: contract.SignInRequest } },
      },
    },
    responses: {
      201: {
        ...json("Who you now are. The credential itself is in the cookie.", Session),
        headers: contract.SessionCookieSet,
      },
      400: REFUSALS.invalid,
      401: json("Those credentials are not valid.", contract.InvalidCredentials),
      500: REFUSALS.serverError,
      503: REFUSALS.unavailable,
    },
  });

// ---- Everything else ---------------------------------------------------------------------

/**
 * Creates a Merchant — how a deployment grows a team.
 *
 * It is an ordinary guarded route, and that is the whole of what is interesting about it. It
 * used to answer an anonymous request while the deployment held no Merchant, which was
 * race-safe and still meant whoever reached a fresh deployment first owned the Store. The
 * *first* Merchant is seeded at boot from what the deployment was configured with instead
 * (`auth/seed.ts`), so there is nothing left here that a stranger may reach.
 */
const createMerchantRoute = createRoute({
  method: "post",
  path: "/merchants",
  summary: "Create a Merchant",
  description:
    "Adds a colleague. The deployment's *first* Merchant does not come from here — it is seeded at boot from the deployment's own configuration, because a deployment with no Merchant has nobody who could hold this permission.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.merchantWrite)] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: contract.CreateMerchantRequest } },
    },
  },
  responses: {
    201: json("The Merchant, and the Role they hold.", contract.Merchant),
    400: REFUSALS.invalid,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    409: json("A Merchant already holds that address.", contract.Refusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/** The other route answering with a `Session`, and so the other one built per instance. */
const readSessionRoute = (Session: contract.SessionSchema) =>
  createRoute({
    method: "get",
    path: "/session",
    summary: "Who the caller is",
    description:
      "What the Admin asks first after a page load: who am I, and what may I do.",
    security: MERCHANT_SESSION,
    responses: {
      200: json("The caller's Merchant and Role.", Session),
      401: REFUSALS.noSession,
      500: REFUSALS.serverError,
      503: REFUSALS.unavailable,
    },
  });

const signOutRoute = createRoute({
  method: "delete",
  path: "/session",
  summary: "Sign out",
  description:
    "The row goes, so the session stops working on the very next request, and the cookie is cleared so the browser stops sending it. Both halves matter: clearing only the cookie would leave a live session behind, and deleting only the row would leave the browser presenting a credential to be refused.",
  security: MERCHANT_SESSION,
  responses: {
    204: { description: "Signed out.", headers: contract.SessionCookieCleared },
    401: REFUSALS.noSession,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const readStoreRoute = createRoute({
  method: "get",
  path: "/store",
  summary: "Read the Store",
  description: "One deployment is one Store (ADR-0005), so this takes no identifier.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeRead)] as const,
  responses: {
    200: json("The Store.", contract.Store),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Creates a Product and the Variants that make it sellable, in one transaction.
 *
 * There is deliberately no route that creates a Product on its own. A Product is never
 * sellable in itself (ADR-0008), so one with no Variant is a catalog entry nothing can buy
 * — and the cheapest way to guarantee that state never exists is to give the API no way to
 * reach it, rather than to detect and repair it afterwards.
 */
const createProductRoute = createRoute({
  method: "post",
  path: "/products",
  summary: "Create a Product",
  description:
    "A Product and its Variants are created together. There is no route that creates a Product alone, so a Product with no Variant is not a state this API can produce.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: contract.CreateProductRequest } },
    },
  },
  responses: {
    201: json("The Product, with its Variants.", contract.ProductDetail),
    400: REFUSALS.invalid,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    409: json("A Variant already carries one of those SKUs.", contract.Refusal),
    422: json(
      "A Variant names a Fulfilment Strategy this deployment has not wired. Core ships `physical` and `digital`; a Plugin's is wired in the Project's `kobai.config.ts`, and installing the Plugin does not wire it.",
      contract.Refusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const listProductsRoute = createRoute({
  method: "get",
  path: "/products",
  summary: "List Products",
  description:
    "Newest first, unpaginated. The envelope is why pagination can arrive beside the list rather than by breaking this response.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogRead)] as const,
  responses: {
    200: json("Every Product.", contract.ProductList),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const readProductRoute = createRoute({
  method: "get",
  path: "/products/{id}",
  summary: "Read a Product",
  description: "One Product, with its Variants and each Variant's Prices.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogRead)] as const,
  request: { params: contract.IdParam },
  responses: {
    200: json("The Product.", contract.ProductDetail),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Product exists.", contract.Refusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Deletes a Product and every Variant of it.
 *
 * The Orders placed for those Variants are untouched, which is what makes a catalog entry
 * something a Merchant may simply be rid of rather than something they must keep forever in
 * case the books need it (ADR-0009).
 */
const deleteProductRoute = createRoute({
  method: "delete",
  path: "/products/{id}",
  summary: "Delete a Product",
  description:
    "Every Variant of it goes too, with their Prices and stock counts — this is also how a Product's last Variant is deleted, since a Variant that is a Product's only one cannot be deleted on its own (ADR-0008). Orders already placed are untouched: their Line Items are a snapshot (ADR-0009).",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: { params: contract.IdParam },
  responses: {
    204: { description: "Deleted." },
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Product exists.", contract.Refusal),
    409: json(
      "`stock-is-reserved`: one of this Product's Variants has stock currently claimed by Reservations being placed. Those either become Orders or lapse, and it can be deleted once they have.",
      contract.Refusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Deletes a Variant — the sellable thing, and everything that only means anything while it is
 * sellable.
 *
 * An Order placed for it is untouched, which is the whole reason this route can exist at all:
 * its Line Items are a snapshot and the reference they keep to the Variant is for navigation
 * only, so it goes to `null` and nothing a Shopper or an accountant reads moves (ADR-0009).
 */
const deleteVariantRoute = createRoute({
  method: "delete",
  path: "/variants/{id}",
  summary: "Delete a Variant",
  description:
    "Its Prices, its stock count and any Cart line that selected it go with it. Orders do not: an Order's Line Items are a snapshot, so deleting the Variant they were placed for leaves them saying exactly what was bought and what it cost (ADR-0009).",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: { params: contract.IdParam },
  responses: {
    204: { description: "Deleted." },
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Variant exists.", contract.Refusal),
    409: json(
      "Two reasons: `last-variant`, this is the only Variant of its Product and every Product has at least one (ADR-0008) — delete the Product instead, which takes this Variant with it; or `stock-is-reserved`, its stock is currently claimed by Reservations being placed, which either become Orders or lapse.",
      contract.Refusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Adds a Price to a Variant — an insert, never an update.
 *
 * The Variant is what the route addresses because the Variant is what is sellable. Calling
 * this twice leaves a Variant with two Prices rather than one overwritten one, which is
 * ADR-0008's shape working: sale prices, further currencies and quantity breaks are more
 * rows here, not a migration.
 */
const setPriceRoute = createRoute({
  method: "post",
  path: "/variants/{id}/prices",
  summary: "Price a Variant",
  description:
    "An insert, never an update. Calling this twice leaves a Variant with two Prices — which is how sale prices, further currencies and quantity breaks arrive without a migration.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.SetPriceRequest } },
    },
  },
  responses: {
    201: json("The Price.", contract.Price),
    400: REFUSALS.invalid,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Variant exists.", contract.Refusal),
    422: json(
      "Well formed, and still refused: this Store does not price in that currency.",
      contract.Refusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Removes one Price from a Variant — the other half of an insert-only surface.
 *
 * Addressed through the Variant, exactly as setting one is, so the two routes read as one
 * pair and a Price identifier belonging to another Variant is not found rather than obeyed.
 *
 * There is no refusal for the last one. A Variant with no Price is a state the API already
 * produces at creation, and taking the last Price away is the quickest thing a Merchant can
 * do to stop something being sold: an unpriced Variant cannot be quoted and cannot be put in
 * a Cart.
 */
const deletePriceRoute = createRoute({
  method: "delete",
  path: "/variants/{id}/prices/{priceId}",
  summary: "Remove a Price",
  description:
    "Removing the last one is allowed and leaves the Variant unpriced, which is how a Merchant stops something being sold at once — an unpriced Variant cannot be quoted and cannot be put in a Cart. Orders already placed are unaffected: what was charged is on the Order (ADR-0009).",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: { params: contract.VariantPriceParams },
  responses: {
    204: { description: "Removed." },
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Variant exists, or it carries no such Price.", contract.Refusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Sets what the Store has of a Variant — the Merchant's half of Inventory (ADR-0018).
 *
 * `catalog:write` rather than a permission of its own. A stock count is a fact about a Variant,
 * and the Merchant who may price a Variant is the one who may say how many there are; ADR-0027
 * settles that a Role is subdivided later by adding rows, which is what to do on the day a
 * deployment wants a stock clerk who may not edit the catalog.
 *
 * A `PUT` because it is idempotent and because it is a *count* rather than an adjustment:
 * sending the same body twice leaves the same stock, which `POST /variants/{id}/prices`
 * deliberately does not. It is also what makes a Variant tracked — "start counting this" and
 * "there are seven" are the same sentence, so they are not two routes.
 *
 * Reading it back is `GET /admin/products/{id}`, where a Merchant is already looking: every
 * Variant there carries its Inventory, or `null` when nobody is counting it.
 */
const setInventoryRoute = createRoute({
  method: "put",
  path: "/variants/{id}/inventory",
  summary: "Count a Variant's stock",
  description:
    "A statement of what the Store has, replacing whatever was there — not an adjustment to it. The first call is what makes a Variant tracked; an untracked Variant sells freely, which is not the same as one counted at zero. `reserved` is never set here: it belongs to the Reservations currently being placed. Read it back with the Product.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.SetInventoryRequest } },
    },
  },
  responses: {
    200: json("What the Store now has of this Variant.", contract.Inventory),
    400: REFUSALS.invalid,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Variant exists.", contract.Refusal),
    409: json(
      "More than that is currently claimed by Reservations being placed. Those either become Orders or lapse, and the count can be set once they have.",
      contract.Refusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Mints an API key — the credential the store surface is gated by (ADR-0020).
 *
 * The value is in this response and in no other, ever: only a digest is stored, so there
 * is nothing to show a second time. That is the same bargain the password column makes,
 * and it is why the route answers with the key rather than making a Merchant fetch it.
 */
const createApiKeyRoute = createRoute({
  method: "post",
  path: "/api-keys",
  summary: "Mint an API key",
  description:
    "The value is in this response and in no other, ever — only a digest is stored. `kobai_pk_…` is publishable and `kobai_sk_…` is secret, so the kind is readable off the value itself.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.apiKeyWrite)] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: contract.CreateApiKeyRequest } },
    },
  },
  responses: {
    201: json("The key, shown once.", contract.IssuedApiKey),
    400: REFUSALS.invalid,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Every key this deployment has issued — the route that makes revocation reachable.
 *
 * Minting answers with the value once and the id once, so before this existed a Merchant who
 * lost that response held a live credential they could not name. Nothing here is presentable:
 * only a digest of a key is stored, so there is no value to leak and no fragment of one is
 * offered in its place.
 *
 * `api-key:read` rather than `api-key:write`: seeing which credentials exist and handing out
 * a new one are different powers, and each route names the one permission it needs.
 */
const listApiKeysRoute = createRoute({
  method: "get",
  path: "/api-keys",
  summary: "List API keys",
  description:
    "Newest first, unpaginated, revoked keys included. It carries no key value and no fragment of one — only a digest is stored, so there is nothing to show a second time.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.apiKeyRead)] as const,
  responses: {
    200: json("Every API key, and whether it still works.", contract.ApiKeyList),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const revokeApiKeyRoute = createRoute({
  method: "delete",
  path: "/api-keys/{id}",
  summary: "Revoke an API key",
  description: "It stops working on the very next request, like a deleted Session.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.apiKeyWrite)] as const,
  request: { params: contract.IdParam },
  responses: {
    204: { description: "Revoked." },
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such API key exists.", contract.Refusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * The Orders this Store has taken — what a Merchant opens the Admin to see (spec story 56).
 *
 * `order:read`, and not `catalog:read`: the books and the catalog are different powers, and a
 * colleague who maintains Products has no business reading what every Shopper paid. ADR-0027
 * settled that this is one permission string on a Role rather than a rule about *which* Orders,
 * so the gate answers once, before the handler, and never walks the rows it is about to return.
 *
 * There is no route beside these two that writes one. An Order is immutable (ADR-0009), and the
 * one that places it is on the store surface where a storefront can reach it.
 */
const listOrdersRoute = createRoute({
  method: "get",
  path: "/orders",
  summary: "List Orders",
  description:
    "Newest first, unpaginated, and without Line Items — open one for those. The envelope is why pagination can arrive beside the list rather than by breaking this response.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.orderRead)] as const,
  responses: {
    200: json("Every Order this Store has taken.", contract.OrderList),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * One Order, opened — the same record the storefront that placed it can read.
 *
 * Byte for byte the same shape `GET /store/orders/{id}` answers with, deliberately: an Order is
 * one record and a Merchant reading it over the phone to a Shopper should be looking at what
 * the Shopper is looking at. What differs is the credential, not the answer.
 */
const readOrderRoute = createRoute({
  method: "get",
  path: "/orders/{id}",
  summary: "Read an Order",
  description:
    "Its Line Items as they were snapshotted at Capture, its Adjustments, its totals, its Order number and the Payment recorded against it. Nothing here is joined to the catalog, so renaming a Product does not rewrite it (ADR-0009).",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.orderRead)] as const,
  request: { params: contract.IdParam },
  responses: {
    200: json("The Order.", contract.Order),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Order exists.", contract.OrderRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

export function createAdminRoutes(deps: AdminDependencies): OpenAPIHono<AdminEnv> {
  const admin = new OpenAPIHono<AdminEnv>({ defaultHook: invalidRequestHook });

  // Built once, here, and given to both routes that answer with one: the schema carries this
  // deployment's idle window in its description, and two schemas registered under the same
  // component name would be two answers to the same question.
  const Session = contract.sessionSchema(deps.sessionPolicy);

  admin.openapi(signInRoute(Session), async (c) => {
    const body = c.req.valid("json");

    const merchant = await authenticateMerchant(deps.db, body.email, body.password);
    if (!merchant) {
      // One answer for an unknown address and for a wrong password. Distinguishing them would
      // turn this endpoint into a way to ask who works here.
      return c.json(
        {
          error: "Those credentials are not valid.",
          reason: "invalid-credentials" as const,
        },
        401,
      );
    }

    const issued = await createSession(deps.db, merchant.id, deps.sessionPolicy);

    // The credential leaves in a header and not in the body. That is the whole switch: a
    // token in a response body is a token every logging integration is one `JSON.stringify`
    // away from writing down (ADR-0032).
    c.header("set-cookie", sessionCookie(issued.token, scheme(c)));
    return c.json(sessionBody(merchant, merchant.role, issued.expiresAt), 201);
  });

  const guarded = new OpenAPIHono<AdminEnv>({ defaultHook: invalidRequestHook });
  guarded.use("*", requireSession(deps.db, deps.sessionPolicy));

  guarded.openapi(createMerchantRoute, async (c) => {
    const created = await createMerchant(deps.db, c.req.valid("json"));
    if (!created.ok) return refused(c, created, CREATION_STATUS);
    return c.json(created.merchant, 201);
  });

  guarded.openapi(readSessionRoute(Session), (c) => {
    const auth = authenticated(c);
    return c.json(sessionBody(auth.merchant, auth.role, auth.expiresAt), 200);
  });

  guarded.openapi(signOutRoute, async (c) => {
    await revokeSession(deps.db, authenticated(c).sessionId);
    c.header("set-cookie", clearedSessionCookie(scheme(c)));
    return c.body(null, 204);
  });

  guarded.openapi(readStoreRoute, async (c) => {
    const store = await readStore(deps.db);
    if (!store) {
      return c.json(
        { error: "No Store exists. The database is migrated but unseeded." },
        500,
      );
    }
    return c.json(store, 200);
  });

  guarded.openapi(createProductRoute, async (c) => {
    const created = await createProduct(deps.db, c.req.valid("json"), deps.fulfilment);
    if (!created.ok) return refused(c, created, PRODUCT_STATUS);
    return c.json(created.product, 201);
  });

  guarded.openapi(listProductsRoute, async (c) => {
    return c.json({ products: await listProducts(deps.db) }, 200);
  });

  guarded.openapi(readProductRoute, async (c) => {
    const found = await readProduct(deps.db, c.req.valid("param").id);
    if (!found) {
      return c.json(
        { error: "No such Product exists.", reason: "product-not-found" },
        404,
      );
    }
    return c.json(found, 200);
  });

  guarded.openapi(deleteProductRoute, async (c) => {
    const deleted = await deleteProduct(deps.db, c.req.valid("param").id);
    if (!deleted.ok) return refused(c, deleted, PRODUCT_DELETION_STATUS);
    return c.body(null, 204);
  });

  guarded.openapi(deleteVariantRoute, async (c) => {
    const deleted = await deleteVariant(deps.db, c.req.valid("param").id);
    if (!deleted.ok) return refused(c, deleted, VARIANT_DELETION_STATUS);
    return c.body(null, 204);
  });

  guarded.openapi(setPriceRoute, async (c) => {
    const created = await setPrice(deps.db, c.req.valid("param").id, c.req.valid("json"));
    if (!created.ok) return refused(c, created, PRICE_STATUS);
    return c.json(created.price, 201);
  });

  guarded.openapi(deletePriceRoute, async (c) => {
    const params = c.req.valid("param");
    const deleted = await deletePrice(deps.db, params.id, params.priceId);
    if (!deleted.ok) return refused(c, deleted, PRICE_DELETION_STATUS);
    return c.body(null, 204);
  });

  guarded.openapi(setInventoryRoute, async (c) => {
    const counted = await setInventory(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    if (!counted.ok) return refused(c, counted, INVENTORY_STATUS);
    return c.json(counted.inventory, 200);
  });

  guarded.openapi(listOrdersRoute, async (c) => {
    return c.json({ orders: await listOrders(deps.db) }, 200);
  });

  guarded.openapi(readOrderRoute, async (c) => {
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

  guarded.openapi(createApiKeyRoute, async (c) => {
    const created = await createApiKey(deps.db, c.req.valid("json"));
    if (!created.ok) return refused(c, created, API_KEY_STATUS);
    return c.json(created.apiKey, 201);
  });

  guarded.openapi(listApiKeysRoute, async (c) => {
    return c.json({ apiKeys: await listApiKeys(deps.db) }, 200);
  });

  guarded.openapi(revokeApiKeyRoute, async (c) => {
    const revoked = await revokeApiKey(deps.db, c.req.valid("param").id);
    if (!revoked) {
      return c.json(
        { error: "No such API key exists.", reason: "api-key-not-found" },
        404,
      );
    }
    return c.body(null, 204);
  });

  admin.route("/", guarded);

  return admin;
}

/**
 * 400 for a request that is wrong, 409 for one another row already answered, and 422 for a
 * Fulfilment Strategy this deployment has not wired.
 *
 * The last is `unsupported-currency`'s distinction rather than `invalid`'s: the body is well
 * formed and names a Strategy that could perfectly well exist — it is *this* deployment that
 * has not wired it, which is a fact about the Store and is fixed in `kobai.config.ts` rather
 * than in the request.
 */
const PRODUCT_STATUS = {
  invalid: 400,
  "sku-taken": 409,
  "unknown-fulfilment-strategy": 422,
} as const satisfies Record<
  Exclude<ProductCreation, { ok: true }>["reason"],
  400 | 409 | 422
>;

/** Only one way to get a key wrong, and it is the request's fault. */
const API_KEY_STATUS = {
  invalid: 400,
} as const satisfies Record<Exclude<ApiKeyCreation, { ok: true }>["reason"], 400>;

/**
 * 409 for stock already claimed: the request is well formed and the state of the Store refuses
 * it — the same distinction `sku-taken` draws — and it becomes settable again by itself, as
 * those Reservations become Orders or lapse.
 */
const INVENTORY_STATUS = {
  "variant-not-found": 404,
  "stock-is-reserved": 409,
} as const satisfies Record<Exclude<InventoryUpdate, { ok: true }>["reason"], 404 | 409>;

/**
 * 409 for stock already claimed, exactly as `PUT /variants/{id}/inventory` answers about the
 * same units: the request is well formed and the state of the Store refuses it, and it becomes
 * deletable again by itself as those Reservations become Orders or lapse.
 */
const PRODUCT_DELETION_STATUS = {
  "product-not-found": 404,
  "stock-is-reserved": 409,
} as const satisfies Record<Exclude<ProductDeletion, { ok: true }>["reason"], 404 | 409>;

/** 409 for the two refusals that are facts about the Store rather than about the request. */
const VARIANT_DELETION_STATUS = {
  "variant-not-found": 404,
  "last-variant": 409,
  "stock-is-reserved": 409,
} as const satisfies Record<Exclude<VariantDeletion, { ok: true }>["reason"], 404 | 409>;

/** Both halves of a Price's address can be wrong, and neither is more than a 404. */
const PRICE_DELETION_STATUS = {
  "variant-not-found": 404,
  "price-not-found": 404,
} as const satisfies Record<Exclude<PriceDeletion, { ok: true }>["reason"], 404>;

/** 422 for a currency this Store does not price in: well-formed, and still refused. */
const PRICE_STATUS = {
  invalid: 400,
  "unsupported-currency": 422,
  "variant-not-found": 404,
} as const satisfies Record<
  Exclude<PriceCreation, { ok: true }>["reason"],
  400 | 404 | 422
>;

/**
 * Which scheme this request arrived over, which is all the cookie needs to know.
 *
 * Read from the request rather than from configuration, so the same build sets a `Secure`
 * cookie behind TLS and a working one over the plain HTTP `devbox run up` serves.
 */
function scheme(c: Context<AdminEnv>): Scheme {
  return schemeOf(c.req.url, c.req.header("x-forwarded-proto"));
}

/** One shape for "you are signed in", whether it is being issued or merely reported. */
function sessionBody(merchant: MerchantIdentity, role: RoleSummary, expiresAt: Date) {
  return {
    expiresAt: expiresAt.toISOString(),
    merchant: { id: merchant.id, email: merchant.email },
    role: { name: role.name, permissions: role.permissions },
  };
}

/**
 * 400 when the request was wrong, 409 when a row that already exists is what refuses it — the
 * distinction between "fix your request" and "somebody got there first".
 */
const CREATION_STATUS = {
  invalid: 400,
  "unknown-role": 400,
  "email-taken": 409,
} as const satisfies Record<Exclude<MerchantCreation, { ok: true }>["reason"], 400 | 409>;

/**
 * One shape for every refusal this surface makes: `{ error, reason }`, at the status its
 * reason names.
 *
 * The gate answers in that shape (`auth/gate.ts`), so everything below it answers in the same
 * one — a client parses refusals one way whether it was turned back at the door or by the
 * handler. The status map is passed in rather than switched on here, so a module that grows a
 * reason has one place to say what it means and the compiler asks for it: `satisfies Record<…>`
 * on each map makes an unmapped reason a build failure rather than an `undefined` status. The
 * route declaring that status is the second half of the same guarantee — a status no route
 * names does not typecheck.
 */
function refused<Reason extends string, Status extends ContentfulStatusCode>(
  c: Context<AdminEnv>,
  failure: { readonly reason: Reason; readonly detail: string },
  statuses: Record<Reason, Status>,
) {
  return c.json(
    { error: failure.detail, reason: failure.reason },
    statuses[failure.reason],
  );
}

/**
 * There is deliberately no catch-all here.
 *
 * An unrouted `/admin` path is answered by `app.notFound` in `app.ts`, in the same
 * `{ error, reason }` shape every refusal above uses (#33, ADR-0040). One handler covers
 * every surface rather than one per surface, so there is nothing to keep in step here. The
 * description is unchanged either way: it names the routes that exist, and promises nothing
 * about the ones that do not.
 */
