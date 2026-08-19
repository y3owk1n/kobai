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
  listMerchants,
  type MerchantCreation,
  type MerchantUpdate,
  updateMerchant,
} from "../auth/merchant.ts";
import { PERMISSIONS } from "../auth/permissions.ts";
import {
  createRole,
  deleteRole,
  listRoles,
  type RoleCreation,
  type RoleDeletion,
  type RoleUpdate,
  readRole,
  updateRole,
} from "../auth/role.ts";
import { createSession, revokeSession, type SessionPolicy } from "../auth/session.ts";
import {
  clearedSessionCookie,
  type Scheme,
  schemeOf,
  sessionCookie,
} from "../auth/session-cookie.ts";
import { listCarts, readCart } from "../cart/read.ts";
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
  type ProductUpdate,
  updateProduct,
  updateVariant,
  type VariantUpdate,
} from "../catalog/update.ts";
import {
  addVariant,
  createProduct,
  type PriceCreation,
  type ProductCreation,
  setPrice,
  type VariantCreation,
} from "../catalog/write.ts";
import type { Database } from "../db/client.ts";
import { DEFAULT_PAGE_LIMIT } from "../db/page.ts";
import {
  type FulfilmentStrategies,
  fulfilmentStrategyNames,
} from "../fulfilment/strategy.ts";
import { listOrders, readOrder } from "../order/read.ts";
import { type InventoryUpdate, setInventory } from "../reservation/inventory.ts";
import { readStore } from "../store/read.ts";
import { type StoreUpdate, updateStore } from "../store/write.ts";
import * as contract from "./contract.ts";
import {
  invalidRequestHook,
  json,
  MERCHANT_SESSION,
  PAGE_QUERY_INVALID,
  REFUSALS,
} from "./openapi.ts";

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
 * The 400 a catalog route answers — `REFUSALS.invalid`'s body, declared through the catalog
 * family's schema.
 *
 * Its own constant rather than `REFUSALS.invalid` because a catalog route's 400 belongs to the
 * catalog family: one schema per family is what ADR-0060 settled on, so the 400 a route shares
 * with every other route is declared through the same schema as its 409 and its 422. The
 * wording is the shared one because the refusal is — only the set of reasons the schema admits
 * is wider, and `refusal-reasons.test.ts` is what holds that set to what this route answers.
 */
const CATALOG_INVALID_REQUEST = json(
  "The request does not fit this endpoint's schema, or is not JSON at all.",
  contract.CatalogRefusal,
);

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
    400: json(
      "The request does not fit this endpoint's schema, is not JSON at all, or names a Role this deployment does not have.",
      contract.MerchantRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    409: json("A Merchant already holds that address.", contract.MerchantRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Lists the Merchants of this deployment, each with the Role they hold.
 *
 * Merchants were write-only until #173: one could be created and never seen again, which made
 * *who has access* a question this API could not answer about itself.
 *
 * **Gated by `merchant:read`, and not by the `merchant:write` that creates one** (ADR-0066).
 * Adding a colleague confers everything, because the colleague can be added against `owner`, so
 * one Permission covers every write on this surface; reading the roster confers nothing, and
 * gating it the same way would mean granting the power to change who has access in order to let
 * somebody see it.
 */
const listMerchantsRoute = createRoute({
  method: "get",
  path: "/merchants",
  summary: "List Merchants",
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time — who has access to this deployment, and what each of them may do. Ask for more with \`limit\`, and for what follows a page with the \`nextCursor\` it answered (ADR-0064).`,
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.merchantRead)] as const,
  request: { query: contract.pageQuery("merchants") },
  responses: {
    200: json("A page of Merchants.", contract.MerchantList),
    400: PAGE_QUERY_INVALID,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Moves a Merchant onto another Role — and refuses the one move a deployment cannot come back
 * from (#202, ADR-0066).
 *
 * **This is what makes `role-in-use` a step rather than a wall.** `DELETE /admin/roles/{id}`
 * refuses while any Merchant holds the Role and points at the Merchants who do; until this
 * route there was no way for any of them to stop holding it, so a Role somebody held was
 * permanent and the only advice this API could honestly give was to narrow its Permissions
 * instead. Both halves of ADR-0059's argument — refuse rather than cascade, because "the repair
 * is one a Merchant can carry out themselves" — needed this route to be true.
 *
 * **Gated by `merchant:write`, and it needs no Permission of its own** (ADR-0066): a Merchant
 * who may add a colleague may add one against `owner`, so that Permission is already the power
 * to administer access entire, and moving a colleague between Roles confers nothing it did not.
 *
 * `last-administrator` is answered when this Merchant is the only one holding `merchant:write`
 * and the Role named does not carry it. That is the same refusal `PATCH /admin/roles/{id}`
 * makes and the same fact about the deployment; what differs is which act would have caused it,
 * and both take one lock so that neither can slip past the other.
 */
const updateMerchantRoute = createRoute({
  method: "patch",
  path: "/merchants/{id}",
  summary: "Move a Merchant onto another Role",
  description:
    "Changes which Role a Merchant holds, by name. It takes effect on their very next request, signed in or not — a Role is read on each one. Naming the Role they already hold changes nothing and is answered 200; a body naming nothing this route would change is refused at 400. Their address and password are not correctable over this API at all.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.merchantWrite)] as const,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.UpdateMerchantRequest } },
    },
  },
  responses: {
    200: json("The Merchant, and the Role they now hold.", contract.Merchant),
    400: json(
      "The request does not fit this endpoint's schema, is not JSON at all, names a Role this deployment does not have, or names nothing this route would change.",
      contract.MerchantRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Merchant exists.", contract.MerchantRefusal),
    422: json(
      "Well formed, and still refused: `last-administrator`, this is the only Merchant who can administer Merchants and the Role named cannot, so the move would leave the deployment with nobody who could undo it.",
      contract.MerchantRefusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Creates a Role — a name and the set of Permissions a Merchant created against it holds.
 *
 * The route that makes ADR-0027's permission model reachable. Exactly one Role existed before
 * it, seeded by `0003` and holding everything, so a deployment had one kind of Merchant and
 * permission-gating was a mechanism nobody could use.
 *
 * **A Permission this build of Core has never heard of is stored, not refused** (ADR-0066).
 * `permissions` is `array(string)` here for that reason and must stay so: closing it would
 * contradict the `Session` schema one field away, which already promises a deployment may hold
 * a Permission Core does not know.
 */
const createRoleRoute = createRoute({
  method: "post",
  path: "/roles",
  summary: "Create a Role",
  description:
    "A Role is a name and a set of Permission strings (ADR-0027). Which strings is not checked against Core's own: an unknown word is stored and answered back unchanged, so a Plugin's Permission needs no release of Core to become sayable. A Role holding none is valid — it can sign in and reach nothing.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.merchantWrite)] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: contract.CreateRoleRequest } },
    },
  },
  responses: {
    201: json("The Role.", contract.Role),
    400: json(
      "The request does not fit this endpoint's schema, or is not JSON at all.",
      contract.RoleRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    409: json("A Role already carries that name.", contract.RoleRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Lists the Roles this deployment has.
 *
 * **Gated by `merchant:read`**, as the read beside it is: what a colleague may be given is part
 * of who has access, and seeing it is not the power to change it (ADR-0066).
 */
const listRolesRoute = createRoute({
  method: "get",
  path: "/roles",
  summary: "List Roles",
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time — what this deployment may assign a colleague. Ask for more with \`limit\`, and for what follows a page with the \`nextCursor\` it answered (ADR-0064).`,
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.merchantRead)] as const,
  request: { query: contract.pageQuery("roles") },
  responses: {
    200: json("A page of Roles.", contract.RoleList),
    400: PAGE_QUERY_INVALID,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const readRoleRoute = createRoute({
  method: "get",
  path: "/roles/{id}",
  summary: "Read a Role",
  description: "One Role, and everything it may do.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.merchantRead)] as const,
  request: { params: contract.IdParam },
  responses: {
    200: json("The Role.", contract.Role),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Role exists.", contract.RoleRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Changes a Role — and refuses the one change a deployment cannot come back from.
 *
 * `last-administrator` is answered when taking `merchant:write` off this Role would leave no
 * Merchant holding it anywhere. That is a lockout rather than a preference: the deployment
 * would have nobody who could put the Permission back and nobody who could sign a colleague up
 * to try, so the only way in would be the raw SQL this whole surface exists to remove
 * (ADR-0066). `PATCH /admin/merchants/{id}` can reach the same state from the other side and
 * refuses it by the same name, under the same lock.
 *
 * **A change takes effect on the next request**, because the gate reads the Role on every one
 * (`auth/session.ts`) rather than copying it into the session — so a Merchant narrowed while
 * signed in is narrowed now, and `GET /admin/session` reports what they actually hold.
 */
const updateRoleRoute = createRoute({
  method: "patch",
  path: "/roles/{id}",
  summary: "Change a Role",
  description:
    "Changes only what is named; a field left out is left alone, a named `permissions` replaces the whole set, and a named `metadata` replaces what is stored rather than merging into it. It takes effect immediately for every Merchant holding this Role, signed in or not — a Role is read on each request. A body naming nothing this route would change is refused at 400.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.merchantWrite)] as const,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.UpdateRoleRequest } },
    },
  },
  responses: {
    200: json("The Role, as a read of it reports it.", contract.Role),
    400: json(
      "The request does not fit this endpoint's schema, is not JSON at all, or names nothing this route would change.",
      contract.RoleRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Role exists.", contract.RoleRefusal),
    409: json("A Role already carries that name.", contract.RoleRefusal),
    422: json(
      "Well formed, and still refused: `last-administrator`, every Merchant who can administer Merchants holds this Role, so this change would leave the deployment with nobody who could undo it.",
      contract.RoleRefusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Deletes a Role, and **refuses while any Merchant holds it** — ADR-0059's shape, reached
 * through the one foreign key that points at this table.
 *
 * Neither of the alternatives survives being written down: cascading deletes people to tidy up
 * a label, and reassigning is Core choosing what a colleague becomes. Only refusing is
 * reversible, and the Merchants it protects are ones a Merchant can move themselves.
 */
const deleteRoleRoute = createRoute({
  method: "delete",
  path: "/roles/{id}",
  summary: "Delete a Role",
  description:
    "A Role no Merchant holds. One that Merchants do hold is refused rather than cascading onto them or moving them somewhere Core chose — `GET /admin/merchants` says who they are, and `PATCH /admin/merchants/{id}` is how each of them stops holding it.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.merchantWrite)] as const,
  request: { params: contract.IdParam },
  responses: {
    204: { description: "Deleted." },
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Role exists.", contract.RoleRefusal),
    422: json(
      "Well formed, and still refused: `role-in-use`, Merchants hold this Role and deleting it would leave them signed in holding nothing at all.",
      contract.RoleRefusal,
    ),
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
 * Changes the Store — its name and its metadata, and never the currency it prices in.
 *
 * `store:write` and not `store:read`: seeing what a deployment is called and changing it are
 * different powers, which is the split `catalog:read`/`catalog:write` and
 * `api-key:read`/`api-key:write` already draw. Which gate a route sits behind is promised
 * surface (ADR-0060), so this is not a decision to take once traffic exists.
 *
 * **The default currency is refused rather than changed**, and `store/write.ts` carries that
 * argument in full: every Price already written carries the current one, so moving it would
 * reinterpret those amounts rather than convert them. The field is on the request anyway, so
 * that a form submitting the whole record round-trips and so that the refusal has a name a
 * client can branch on.
 */
const updateStoreRoute = createRoute({
  method: "patch",
  path: "/store",
  summary: "Change the Store",
  description:
    "Changes only what is named; a field left out is left alone, and a named `metadata` replaces what is stored rather than merging into it. `defaultCurrency` may be named and may not be moved: the code this Store already prices in is accepted and changes nothing, and any other is refused, because every Price carries the Store's default currency and no other — changing it would reinterpret each amount already stored rather than convert it. A body naming nothing that would change — `{}`, or only the `defaultCurrency` this Store already has — is refused at 400 rather than answered with the record unchanged.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeWrite)] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: contract.UpdateStoreRequest } },
    },
  },
  responses: {
    200: json("The Store, as a read of it reports it.", contract.Store),
    400: json(
      "The request does not fit this endpoint's schema, is not JSON at all, or names nothing this route would change.",
      contract.StoreRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    422: json(
      "Well formed, and still refused: `default-currency-is-fixed`, the request names a currency other than the one this Store prices in.",
      contract.StoreRefusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * The Fulfilment Strategies this deployment has wired, by name (ADR-0067).
 *
 * It exists because two routes refuse `unknown-fulfilment-strategy` and nothing could ask what
 * the known ones are. A Merchant naming a Strategy — creating a Variant, or swapping one so a
 * poster becomes a download — had to guess and be refused, and a client offering a choice had
 * to hard-code Core's two, which is precisely the closed set ADR-0014 exists to rule out,
 * written into every client instead of into the schema. ADR-0010 calls that a finding about
 * the API rather than a gap in the Admin, and this is the finding answered.
 *
 * **`catalog:read` and not a Permission of its own.** The one thing this is for is filling in
 * a Variant's Strategy, and a Merchant who may not read the catalog has no Variant to fill in;
 * a word of its own would name a boundary that does not exist. Which gate a route sits behind
 * is promised surface (ADR-0060), so it is not a decision to revisit once traffic exists.
 *
 * **It does not page, and that is ADR-0067 rather than an oversight.** Every other list on this
 * surface takes `limit` and `after` and answers a `nextCursor` (ADR-0064), and the argument for
 * that is entirely about rows arriving between one page and the next. There are no rows here —
 * the set is `Object.keys` of what `kobai.config.ts` wired, decided at boot and unable to
 * change while the process runs — so there is nothing to insert, nothing to skip, and no
 * `created_at` a cursor could be built over.
 */
const listFulfilmentStrategiesRoute = createRoute({
  method: "get",
  path: "/fulfilment-strategies",
  summary: "List Fulfilment Strategies",
  description:
    "Every Strategy this deployment has wired, in name order — the complete set a Variant's `fulfilment.strategy` may name, and the set the `unknown-fulfilment-strategy` refusal is made against. It answers a name and nothing else: what a Strategy says about shipping, stock and Lead Time is answered *about a Variant* (ADR-0014), so there is no answer to give without one. **This list does not page**, unlike every other on this surface: it is what a deployment was configured with rather than a table, so it cannot grow while the process runs and there is nothing for a cursor to be built over (ADR-0067).",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogRead)] as const,
  responses: {
    200: json(
      "Every Fulfilment Strategy this deployment has, in name order.",
      contract.FulfilmentStrategyList,
    ),
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
    "A Product, the options it is chosen by and the Variants that make it sellable, created together in one transaction. There is no route that creates a Product alone, so a Product with no Variant is not a state this API can produce — and `options` is declared here for the same reason, so a Variant naming an option its Product has not declared is not one either. A `handle` left out is proposed from the title; one that is given is taken as given, and either way one another Product already answers to is refused rather than suffixed. **What this creates is a draft**, always: no Shopper can see it until `PATCH /admin/products/{id}` publishes it, because publishing is a decision rather than a side effect of creating.",
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
    400: CATALOG_INVALID_REQUEST,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    409: json(
      "Another Product already answers to that handle, or a Variant already carries one of those SKUs.",
      contract.CatalogRefusal,
    ),
    422: json(
      "A Variant names a Fulfilment Strategy this deployment has not wired — Core ships `physical` and `digital`, a Plugin's is wired in the Project's `kobai.config.ts`, and installing the Plugin does not wire it — or a Variant's `options` are not exactly the ones this body declares: `variant-options-mismatch`, naming what it left unanswered and what it named that was never declared.",
      contract.CatalogRefusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const listProductsRoute = createRoute({
  method: "get",
  path: "/products",
  summary: "List Products",
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time. \`status\` narrows to the Products that are drafts, that are published, or that have been archived; the three partition the catalog, and omitting it answers all of them. Ask for more with \`limit\`, and for what follows a page with the \`nextCursor\` it answered — \`nextCursor\` is absent on the last page, and that absence is the only end-of-list signal, which a filtered page being short is not (ADR-0064).`,
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogRead)] as const,
  request: { query: contract.ProductPageQuery },
  responses: {
    200: json("A page of Products.", contract.ProductList),
    400: PAGE_QUERY_INVALID,
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
    404: json("No such Product exists.", contract.CatalogRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Corrects a Product — its title and its metadata.
 *
 * The route ADR-0062 deferred when it settled the Variant's four fields, in its own words "the
 * same shape of question and a much easier one — a Product has no SKU, no Strategy and nothing
 * claiming it". So it is safe for exactly ADR-0009's reason and no other: an Order's Line Items
 * snapshot the title they were bought under, so a typo fixed a year later rewrites nothing
 * anybody has been charged for.
 *
 * **A `PATCH` and not a `PUT`**, and identically to the Variant beside it: a full replacement
 * would make a client that omitted `metadata` clear it, which is data loss spelled as an
 * ordinary request.
 */
const updateProductRoute = createRoute({
  method: "patch",
  path: "/products/{id}",
  summary: "Correct a Product",
  description:
    "Changes only what is named; a field left out is left alone, and a named `metadata` replaces what is stored rather than merging into it. **This is where a Product is published and where it is archived**, through `status`, and **where its options are renamed, reordered, added and removed**, through `options` — which is the whole list rather than a set of edits, so an entry carrying an `id` is the option that already has it and one this Product has that the list does not name is removed. The title is free to move — an Order's Line Items are a snapshot, so nothing already sold is rewritten (ADR-0009). The handle is free to move too, and that is a different kind of freedom: it is the address a storefront links to, so anything already pointing at the old one stops resolving. Variants are not changed here: add one with `POST /admin/products/{id}/variants`, correct one with `PATCH /admin/variants/{id}` — which is also how a Variant is given a value for an option added since it was written.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.UpdateProductRequest } },
    },
  },
  responses: {
    200: json("The Product, with its Variants.", contract.ProductDetail),
    400: CATALOG_INVALID_REQUEST,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Product exists.", contract.CatalogRefusal),
    // The one status this route gained with the handle, and it is creation's own: an address
    // two Products share addresses neither, whichever route asked for it (ADR-0060).
    409: json("Another Product already answers to that handle.", contract.CatalogRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Adds a Variant to a Product that already exists.
 *
 * Addressed through the Product, because a Variant belongs to one and there is nowhere else to
 * say which. It is the other half of `POST /admin/products`: that route makes a Product and
 * the Variants it is born with, and this one is how a second size arrives afterwards — without
 * recreating the Product, which would discard every Price and every stock count under it.
 *
 * The body is `CreateVariantRequest`, the very schema a create nests, so a Variant says the
 * same three things whenever it is made and is refused by the same two words for saying them
 * wrong.
 */
const addVariantRoute = createRoute({
  method: "post",
  path: "/products/{id}/variants",
  summary: "Add a Variant",
  description:
    "A second size, colour or format for a Product a Merchant already has. Its `options` must answer every option that Product declares and only those, exactly as a Variant of a create must. It answers with the new Variant, which starts with no Price and no stock count — `POST /admin/variants/{id}/prices` sets the first, and `PUT /admin/variants/{id}/inventory` counts it. Every Variant already on the Product is untouched, which is the point: recreating the Product to add one would discard their Prices and their counts.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.CreateVariantRequest } },
    },
  },
  responses: {
    201: json("The Variant, as a read of its Product reports it.", contract.Variant),
    400: CATALOG_INVALID_REQUEST,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Product exists.", contract.CatalogRefusal),
    409: json(
      "`sku-taken`: a Variant already carries that SKU, and a SKU identifies one Variant.",
      contract.CatalogRefusal,
    ),
    422: json(
      "Well formed, and still refused: this deployment has not wired a Fulfilment Strategy of that name — Core ships `physical` and `digital`, and a Plugin's is wired in the Project's `kobai.config.ts` — or the `options` are not exactly the ones this Product declares (`variant-options-mismatch`).",
      contract.CatalogRefusal,
    ),
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
    404: json("No such Product exists.", contract.CatalogRefusal),
    409: json(
      "`stock-is-reserved`: one of this Product's Variants has stock currently claimed by Reservations being placed. Those either become Orders or lapse, and it can be deleted once they have.",
      contract.CatalogRefusal,
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
    404: json("No such Variant exists.", contract.CatalogRefusal),
    409: json(
      "Two reasons: `last-variant`, this is the only Variant of its Product and every Product has at least one (ADR-0008) — delete the Product instead, which takes this Variant with it; or `stock-is-reserved`, its stock is currently claimed by Reservations being placed, which either become Orders or lapse.",
      contract.CatalogRefusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Corrects a Variant — its SKU, the Fulfilment Strategy it points at, its metadata.
 *
 * The route ADR-0059 said was missing when it recorded that "recreate it" was the supported
 * repair, and the cost of that repair was a Variant's price history and its stock count. It is
 * safe for ADR-0009's reason and no other: an Order's Line Items snapshot the SKU, the title
 * and the amount, so nothing a Shopper or an accountant reads is joined to the row this
 * changes.
 *
 * **A `PATCH` and not a `PUT`.** A Variant has an open `metadata` bag on it, and a full
 * replacement makes a client that omitted the bag clear it — data loss spelled as an ordinary
 * request. `PUT …/inventory` beside it is the opposite case and stays a `PUT`: a count *is* a
 * statement of the whole fact.
 *
 * Which fields are here, and the three that are deliberately not — a Price, an Inventory count,
 * and the Product this Variant belongs to — is ADR-0062.
 */
const updateVariantRoute = createRoute({
  method: "patch",
  path: "/variants/{id}",
  summary: "Correct a Variant",
  description:
    "Changes only what is named; a field left out is left alone. The SKU and the Fulfilment Strategy are both free to move — an Order's Line Items are a snapshot, so nothing already sold is rewritten (ADR-0009) — and a stock count taken for this Variant is left exactly as it is whichever Strategy it now points at. **`options` is where this Variant says what it is** — its value for each option its Product declares — and it **replaces** every value stored rather than merging into them, so it must answer every declared option and only those. That is also how a Variant is given a value for an option declared on the Product since this Variant was written. A Price is not set here: `POST /admin/variants/{id}/prices` adds one, which supersedes.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.UpdateVariantRequest } },
    },
  },
  responses: {
    200: json("The Variant, as a read of its Product reports it.", contract.Variant),
    400: CATALOG_INVALID_REQUEST,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Variant exists.", contract.CatalogRefusal),
    409: json(
      "`sku-taken`: another Variant already carries that SKU, and a SKU identifies one Variant.",
      contract.CatalogRefusal,
    ),
    422: json(
      "Well formed, and still refused: this deployment has not wired a Fulfilment Strategy of that name — Core ships `physical` and `digital`, and a Plugin's is wired in the Project's `kobai.config.ts` — or the `options` are not exactly the ones this Variant's Product declares (`variant-options-mismatch`).",
      contract.CatalogRefusal,
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
    400: CATALOG_INVALID_REQUEST,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Variant exists.", contract.CatalogRefusal),
    422: json(
      "Well formed, and still refused: this Store does not price in that currency.",
      contract.CatalogRefusal,
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
    404: json(
      "No such Variant exists, or it carries no such Price.",
      contract.CatalogRefusal,
    ),
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
    400: CATALOG_INVALID_REQUEST,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Variant exists.", contract.CatalogRefusal),
    409: json(
      "More than that is currently claimed by Reservations being placed. Those either become Orders or lapse, and the count can be set once they have.",
      contract.CatalogRefusal,
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
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time, revoked keys included. It carries no key value and no fragment of one — only a digest is stored, so there is nothing to show a second time. Pages exactly as the other lists do (ADR-0064).`,
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.apiKeyRead)] as const,
  request: { query: contract.pageQuery("api-keys") },
  responses: {
    200: json("A page of API keys, and whether each still works.", contract.ApiKeyList),
    400: PAGE_QUERY_INVALID,
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
    404: json("No such API key exists.", contract.ApiKeyNotFound),
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
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time, and without Line Items — open one for those. Follow \`nextCursor\` for the next page: this is the list that takes an insert from every Order a storefront places, and a cursor is what makes paging it during a busy hour show each Order exactly once (ADR-0064).`,
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.orderRead)] as const,
  request: { query: contract.pageQuery("orders") },
  responses: {
    200: json("A page of the Orders this Store has taken.", contract.OrderList),
    400: PAGE_QUERY_INVALID,
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

/**
 * The Carts this Store is holding — and the route that reverses a rule Core had written down.
 *
 * `core_cart`'s schema comment used to say there was deliberately no route that lists Carts, so
 * there was nothing to enumerate; both this route and that comment moved in the same change
 * (ADR-0071). The amended rule is that **a Cart identifier is a capability Merchants hold and
 * the public does not** — nothing on the store surface enumerates anything, and this list is
 * behind a Merchant session and `cart:read`.
 *
 * It exists for a question a Merchant genuinely cannot ask otherwise: *why is that stock
 * unavailable?* Once a Cart can hold stock before a Shopper is sent to their bank (ADR-0070),
 * the answer is often a live Cart belonging to somebody who is mid-payment — which is exactly
 * what `state=live` answers.
 *
 * **`cart:read` and not `order:read`.** ADR-0009's first decision is that a Cart and an Order
 * are governed by opposite rules, so merging their Permissions would say the opposite in the one
 * place a deployment configures trust; `catalog:read` would have been worse still, since a Role
 * granted so somebody could edit Products would silently include every Shopper's basket.
 */
const listCartsRoute = createRoute({
  method: "get",
  path: "/carts",
  summary: "List Carts",
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time, and without Line Items — open one for those. \`state\` narrows to the Carts that are live, that expired, or that have already become an Order; the three partition the list, and unfiltered it is mostly history. Follow \`nextCursor\` for the next page (ADR-0064).`,
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.cartRead)] as const,
  request: { query: contract.CartPageQuery },
  responses: {
    200: json("A page of the Carts this Store is holding.", contract.CartList),
    400: PAGE_QUERY_INVALID,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * One Cart, opened — the same record the storefront holding it reads.
 *
 * Byte for byte the shape `GET /store/carts/{id}` answers with, deliberately, exactly as the two
 * Order reads are: a Cart is one record, and a Merchant looking into why something is held
 * should be looking at what the storefront is looking at. What differs is the credential.
 *
 * **That is the safe direction of #207's asymmetry, and the rule it leaves behind is worth
 * knowing.** The catalog shapes are split — `StoreProduct` apart from `Product` — because
 * `/store` is opened by a **publishable** key, so anything those carry is public and a field a
 * Merchant later needs would be published by the deploy that adds it. `Cart` is already the
 * public shape, so a Merchant reading it publishes nothing. What must not happen is the reverse:
 * **a Merchant-only field does not go on `Cart`** — it belongs on a shape this surface owns, or
 * the split arrives here too.
 *
 * **There is no write beside these two, and that is a decision rather than a scope cut.**
 * Releasing a hold by hand takes stock from a Shopper who may be at their bank having already
 * paid — ADR-0070's failure mode, caused deliberately — and the sweeper already releases on
 * expiry. Creating and editing a Cart on a Merchant's behalf is its own spec.
 */
const readCartRoute = createRoute({
  method: "get",
  path: "/carts/{id}",
  summary: "Read a Cart",
  description:
    "Its Line Items as they stand, its deadline, and whether it has expired or has already become an Order. A Cart's lines are live rather than a snapshot, so they follow a catalog that changes under them (ADR-0009) — which is the opposite of what an Order's Line Items do.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.cartRead)] as const,
  request: { params: contract.IdParam },
  responses: {
    200: json("The Cart, with its Line Items.", contract.Cart),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Cart exists.", contract.CartRefusal),
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

  guarded.openapi(listMerchantsRoute, async (c) => {
    const page = await listMerchants(deps.db, c.req.valid("query"));
    return c.json({ merchants: page.items, nextCursor: page.nextCursor }, 200);
  });

  guarded.openapi(updateMerchantRoute, async (c) => {
    const moved = await updateMerchant(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    if (!moved.ok) return refused(c, moved, MERCHANT_UPDATE_STATUS);
    return c.json(moved.merchant, 200);
  });

  guarded.openapi(createRoleRoute, async (c) => {
    const created = await createRole(deps.db, c.req.valid("json"));
    if (!created.ok) return refused(c, created, ROLE_STATUS);
    return c.json(created.role, 201);
  });

  guarded.openapi(listRolesRoute, async (c) => {
    const page = await listRoles(deps.db, c.req.valid("query"));
    return c.json({ roles: page.items, nextCursor: page.nextCursor }, 200);
  });

  guarded.openapi(readRoleRoute, async (c) => {
    const found = await readRole(deps.db, c.req.valid("param").id);
    if (!found) {
      return c.json(
        { error: "No such Role exists.", reason: "role-not-found" as const },
        404,
      );
    }
    return c.json(found, 200);
  });

  guarded.openapi(updateRoleRoute, async (c) => {
    const changed = await updateRole(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    if (!changed.ok) return refused(c, changed, ROLE_UPDATE_STATUS);
    return c.json(changed.role, 200);
  });

  guarded.openapi(deleteRoleRoute, async (c) => {
    const deleted = await deleteRole(deps.db, c.req.valid("param").id);
    if (!deleted.ok) return refused(c, deleted, ROLE_DELETION_STATUS);
    return c.body(null, 204);
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

  guarded.openapi(updateStoreRoute, async (c) => {
    const changed = await updateStore(deps.db, c.req.valid("json"));
    if (!changed.ok) return refused(c, changed, STORE_UPDATE_STATUS);
    return c.json(changed.store, 200);
  });

  guarded.openapi(listFulfilmentStrategiesRoute, (c) => {
    // The same helper the `unknown-fulfilment-strategy` refusals list the known names with, so
    // what this answers and what a refusal names cannot drift apart — one reading of the
    // deployment's own configuration, sorted, rather than two spellings of it.
    const strategies = fulfilmentStrategyNames(deps.fulfilment).map((name) => ({ name }));
    return c.json({ strategies }, 200);
  });

  guarded.openapi(createProductRoute, async (c) => {
    const created = await createProduct(deps.db, c.req.valid("json"), deps.fulfilment);
    if (!created.ok) return refused(c, created, PRODUCT_STATUS);
    return c.json(created.product, 201);
  });

  guarded.openapi(listProductsRoute, async (c) => {
    const page = await listProducts(deps.db, c.req.valid("query"));
    // `undefined` rather than `null`, and `JSON.stringify` drops the key — which is the wire
    // shape ADR-0064 asks for: absent means there is no further page.
    return c.json({ products: page.items, nextCursor: page.nextCursor }, 200);
  });

  guarded.openapi(readProductRoute, async (c) => {
    const found = await readProduct(deps.db, c.req.valid("param").id);
    if (!found) {
      return c.json(
        { error: "No such Product exists.", reason: "product-not-found" as const },
        404,
      );
    }
    return c.json(found, 200);
  });

  guarded.openapi(updateProductRoute, async (c) => {
    const corrected = await updateProduct(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    if (!corrected.ok) return refused(c, corrected, PRODUCT_UPDATE_STATUS);
    return c.json(corrected.product, 200);
  });

  guarded.openapi(addVariantRoute, async (c) => {
    const added = await addVariant(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
      deps.fulfilment,
    );
    if (!added.ok) return refused(c, added, VARIANT_CREATION_STATUS);
    return c.json(added.variant, 201);
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

  guarded.openapi(updateVariantRoute, async (c) => {
    const corrected = await updateVariant(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
      deps.fulfilment,
    );
    if (!corrected.ok) return refused(c, corrected, VARIANT_UPDATE_STATUS);
    return c.json(corrected.variant, 200);
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
    const page = await listOrders(deps.db, c.req.valid("query"));
    return c.json({ orders: page.items, nextCursor: page.nextCursor }, 200);
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

  guarded.openapi(listCartsRoute, async (c) => {
    const page = await listCarts(deps.db, c.req.valid("query"));
    return c.json({ carts: page.items, nextCursor: page.nextCursor }, 200);
  });

  guarded.openapi(readCartRoute, async (c) => {
    const found = await readCart(deps.db, c.req.valid("param").id);
    if (!found) {
      return c.json(
        {
          error:
            "No such Cart exists. A Cart is addressed by the identifier it was created with, and an expired or placed one still reads.",
          reason: "cart-not-found" as const,
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
    const page = await listApiKeys(deps.db, c.req.valid("query"));
    return c.json({ apiKeys: page.items, nextCursor: page.nextCursor }, 200);
  });

  guarded.openapi(revokeApiKeyRoute, async (c) => {
    const revoked = await revokeApiKey(deps.db, c.req.valid("param").id);
    if (!revoked) {
      return c.json(
        { error: "No such API key exists.", reason: "api-key-not-found" as const },
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
  "handle-taken": 409,
  "sku-taken": 409,
  "unknown-fulfilment-strategy": 422,
  // 422 and not 400, and it is the same word wherever a Variant is written. The body is well
  // formed — every field is the type it should be — and what refuses it is what the *Product*
  // declares: a value for an option it does not have, or none for one it does. That is
  // `unknown-fulfilment-strategy`'s distinction one column along, and it is deliberately the
  // same status at a create, where the options are declared in the same body, because it is one
  // fact about a Variant and its Product either way.
  "variant-options-mismatch": 422,
} as const satisfies Record<
  Exclude<ProductCreation, { ok: true }>["reason"],
  400 | 409 | 422
>;

/**
 * 422 for a currency this Store will not move to: the body is well formed and it is the state
 * of the Store that refuses it — `unsupported-currency`'s distinction, about the same column.
 *
 * Not 409, deliberately. A 409 says "somebody got there first" and invites a retry; this one
 * never becomes possible by itself, because what refuses it is every Price already written.
 */
const STORE_UPDATE_STATUS = {
  invalid: 400,
  "default-currency-is-fixed": 422,
} as const satisfies Record<Exclude<StoreUpdate, { ok: true }>["reason"], 400 | 422>;

/**
 * Correcting a Product answers three ways, and the 409 is about the **handle** and never the
 * title: a title identifies nothing, so there is no row that could already have taken one, while
 * a handle is the address a Product is reached at and exactly one Product may hold it.
 *
 * 409 rather than 422, on `sku-taken`'s distinction and for its reason: the body is well formed,
 * the Store is what refuses it, and it becomes possible again by itself the moment the Product
 * holding that address is renamed or removed.
 */
const PRODUCT_UPDATE_STATUS = {
  invalid: 400,
  "product-not-found": 404,
  "handle-taken": 409,
} as const satisfies Record<
  Exclude<ProductUpdate, { ok: true }>["reason"],
  400 | 404 | 409
>;

/**
 * Adding a Variant answers at creation's statuses, plus the one refusal creating a Product
 * cannot make: the Product it is addressed at is not there.
 *
 * 404 for that, and not 409 — nothing conflicts, the address is simply wrong, which is the
 * answer every other route addressing a row that has gone gives.
 */
const VARIANT_CREATION_STATUS = {
  invalid: 400,
  "product-not-found": 404,
  "sku-taken": 409,
  "unknown-fulfilment-strategy": 422,
  // 422 for the same reason and with the same word, wherever a Variant is written — see
  // `PRODUCT_STATUS` above.
  "variant-options-mismatch": 422,
} as const satisfies Record<
  Exclude<VariantCreation, { ok: true }>["reason"],
  400 | 404 | 409 | 422
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

/**
 * Correcting a Variant answers at the statuses creating one already does, because every way it
 * can be refused is a way creating one can be refused (ADR-0062).
 *
 * `sku-taken` at 409 and `unknown-fulfilment-strategy` at 422 are `PRODUCT_STATUS`'s own two,
 * for its own reasons: somebody else has that SKU, and this Store has not wired that Strategy —
 * the second being well formed and refused by the *deployment*, which is fixed in
 * `kobai.config.ts` rather than in the request.
 */
const VARIANT_UPDATE_STATUS = {
  invalid: 400,
  "variant-not-found": 404,
  "sku-taken": 409,
  "unknown-fulfilment-strategy": 422,
  // 422 for the same reason and with the same word, wherever a Variant is written — see
  // `PRODUCT_STATUS` above.
  "variant-options-mismatch": 422,
} as const satisfies Record<
  Exclude<VariantUpdate, { ok: true }>["reason"],
  400 | 404 | 409 | 422
>;

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
 * 400 for a request that is wrong — `unknown-role` included, at the status the create route
 * already answers it at, because one word on one surface should not mean two statuses — 404 for
 * a Merchant who is not there, and 422 for the lockout.
 *
 * The lockout is 422 rather than 409 on ADR-0065's distinction, exactly as the Role surface's
 * is: a 409 says somebody got there first and invites a retry, and this refusal never becomes
 * possible by itself. What lifts it is a deliberate act somewhere else — another Role given
 * `merchant:write`, and a Merchant given that Role.
 */
const MERCHANT_UPDATE_STATUS = {
  invalid: 400,
  "unknown-role": 400,
  "merchant-not-found": 404,
  "last-administrator": 422,
} as const satisfies Record<
  Exclude<MerchantUpdate, { ok: true }>["reason"],
  400 | 404 | 422
>;

/** 400 for a request that is wrong, 409 for a name another Role answered first. */
const ROLE_STATUS = {
  invalid: 400,
  "role-name-taken": 409,
} as const satisfies Record<Exclude<RoleCreation, { ok: true }>["reason"], 400 | 409>;

/**
 * 422 for the lockout, on `default-currency-is-fixed`'s distinction rather than `sku-taken`'s.
 *
 * A 409 says somebody got there first and invites a retry; this refusal never becomes possible
 * by itself, because what lifts it is a deliberate act somewhere else — another Role given
 * `merchant:write`, and a Merchant given that Role.
 */
const ROLE_UPDATE_STATUS = {
  invalid: 400,
  "role-not-found": 404,
  "role-name-taken": 409,
  "last-administrator": 422,
} as const satisfies Record<
  Exclude<RoleUpdate, { ok: true }>["reason"],
  400 | 404 | 409 | 422
>;

/** 422 for the same reason: the rows that refuse this are a Merchant's to move, not a retry's. */
const ROLE_DELETION_STATUS = {
  "role-not-found": 404,
  "role-in-use": 422,
} as const satisfies Record<Exclude<RoleDeletion, { ok: true }>["reason"], 404 | 422>;

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
