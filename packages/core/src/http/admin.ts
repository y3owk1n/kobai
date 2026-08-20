import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
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
  type CollectionCreation,
  type CollectionDeletion,
  type CollectionUpdate,
  createCollection,
  deleteCollection,
  listCollections,
  readCollection,
  unknownCollection,
  updateCollection,
} from "../catalog/collection.ts";
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
import { describeDeployment } from "../deployment/deployment.ts";
import {
  type FulfilmentStrategies,
  fulfilmentStrategyNames,
} from "../fulfilment/strategy.ts";
import {
  listMedia,
  type MediaUploadOutcome,
  refuseDeclaredSize,
  uploadMedia,
} from "../media/media.ts";
import type { MediaPolicy, MediaStorage } from "../media/storage.ts";
import { listOrders, readOrder } from "../order/read.ts";
import type { NotUsable } from "../patch.ts";
import type { PaymentProvider } from "../payment/provider.ts";
import type { PriceResolutionWorkflow } from "../pricing/resolve-price.ts";
import { type InventoryUpdate, setInventory } from "../reservation/inventory.ts";
import {
  type ChannelCreation,
  type ChannelDeletion,
  type ChannelUpdate,
  createChannel,
  deleteChannel,
  listChannels,
  readChannel,
  updateChannel,
} from "../store/channel.ts";
import { readStore } from "../store/read.ts";
import {
  createRegion,
  deleteRegion,
  listRegions,
  type RegionCreation,
  type RegionDeletion,
  type RegionUpdate,
  readRegion,
  updateRegion,
} from "../store/region.ts";
import { type StoreUpdate, updateStore } from "../store/write.ts";
import { openMetadata, type WorkflowRegistry } from "../workflow/context.ts";
import * as contract from "./contract.ts";
import {
  invalidRequestHook,
  json,
  MERCHANT_SESSION,
  type OpenApiDocument,
  PAGE_QUERY_INVALID,
  REFUSALS,
} from "./openapi.ts";
import {
  priceStatusFor,
  resolvedPriceBody,
  workflowRefusal,
} from "./workflow-refusal.ts";

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
   * Where this deployment keeps its Media — what `kobai.config.ts` wired, or the
   * local-filesystem storage Core ships (ADR-0015).
   *
   * Threaded through for the Strategies' reason above: it is a property of the instance, and
   * the address a Media reports is the storage's own answer rather than a column, so two
   * modules reaching for two storages would be two answers about where one Store's images are.
   */
  readonly mediaStorage: MediaStorage;
  /** The ceiling and the accepted content types this deployment declared (#278). */
  readonly mediaPolicy: MediaPolicy;
  /**
   * How long this deployment's sessions live (ADR-0050). The gate below enforces it, and the
   * two routes that answer with a `Session` describe it — which is why those two are declared
   * per instance and every other route on this surface is a module-level constant.
   */
  readonly sessionPolicy: SessionPolicy;
  /**
   * The `resolve-price` declaration this deployment runs, for the one route that previews what a
   * storefront would be charged (#276).
   *
   * Handed in rather than imported, for exactly the reason the store surface's is: a route that
   * imported Core's own declaration would preview Core's prices to a Project that replaced a
   * pricing Step — which is the one thing a preview must never do, since the whole of its value
   * is being the number the storefront gets.
   */
  readonly priceWorkflow: PriceResolutionWorkflow;
  /**
   * How long this deployment holds a Cart's stock (ADR-0075) — threaded here for the same route,
   * and for the reason the store surface threads it.
   *
   * Nothing on this surface claims anything. It is on the context that route builds because a
   * Workflow context is *the deployment's* context, and a route that handed a Step a smaller one
   * than the storefront does would be the preview and the storefront disagreeing about what a
   * replaced Step can read.
   */
  readonly holdWindowMs: number;
  /**
   * Every Workflow declaration this deployment runs, so `GET /admin/deployment` can report the
   * Step in each position and where it came from (ADR-0080).
   *
   * The rewired declarations rather than Core's own: what a Developer is asking is what *this*
   * deployment runs, and Core's default is the answer only where nothing was wired over it.
   */
  readonly workflows: WorkflowRegistry;
  /**
   * The Payment Provider this deployment was wired with, or `undefined` for one wired with none
   * (ADR-0053). Reported as a boolean and never as itself — see `deployment/deployment.ts`.
   */
  readonly paymentProvider: PaymentProvider | undefined;
  /**
   * The release of Core this is, asked rather than read here.
   *
   * A function, and deliberately the very one that fills the description's `info.version`: the
   * surface's version *is* the package's (ADR-0060), so this route is a second reader of that
   * one fact rather than a second copy of it. It is called per request for the reason
   * `coreVersion` is lazy at all — a manifest read belongs where somebody asked for the value,
   * not in front of every boot.
   */
  readonly coreVersion: () => string;
  /**
   * This deployment's own OpenAPI description, asked for when somebody asks for it.
   *
   * A function because the document is a property of the **whole** application — both surfaces,
   * the open Media route, the security schemes registered after the sub-apps — and this module
   * builds one of its halves. `http/app.ts` closes over the finished app and hands the answer
   * back through here, which is also what stops these routes needing a reference to their own
   * parent.
   */
  readonly describeApi: () => OpenApiDocument;
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
    "Changes only what is named; a field left out is left alone, and a named `metadata` replaces what is stored rather than merging into it. `defaultCurrency` may be named and may not be moved: the code this Store already prices in is accepted and changes nothing, and any other is refused, because every Price carrying no Region and no Channel is denominated in it — changing it would reinterpret each of those amounts rather than convert them. **A second currency is enabled rather than substituted**: `currencies` is the complete set this Store may price in, and a Region selects one of them. `defaultRegion` names the Region a storefront that sends none is answered for. A body naming nothing that would change — `{}`, or only the `defaultCurrency` this Store already has — is refused at 400 rather than answered with the record unchanged.",
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
      "Well formed, and still refused: `default-currency-is-fixed`, the request names a currency other than the one this Store prices in; `default-currency-must-be-enabled`, the `currencies` it names leave that one out; `currency-in-use`, they take away a currency a Region selects; or `region-not-found`, `defaultRegion` names no Region this Store has.",
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
 * What this deployment is — the release, the Workflows, and whether money can move.
 *
 * The one route on this surface whose subject is the **deployment** rather than the Store
 * (ADR-0080). Everything a Project configures in `kobai.config.ts` disappears into a process,
 * and until this there was no way back: a Developer answered "which Steps has this replaced" by
 * reading the config file they hoped had shipped.
 *
 * **It carries three things and deliberately not five.** The Fulfilment Strategies are
 * `GET /admin/fulfilment-strategies` and the migration sets are `GET /health`; restating either
 * here would be two descriptions of one fact that can disagree, and both would be promised under
 * ADR-0060 for ever. A screen that wants the whole picture composes three reads.
 *
 * **It does not page**, and it is the second route on the far side of ADR-0067's boundary: a set
 * fixed by the deployment's own configuration, readable in full, unable to change without a
 * restart. There are no rows here, no `created_at`, and nothing that can be inserted between one
 * request and the next.
 */
const readDeploymentRoute = createRoute({
  method: "get",
  path: "/deployment",
  summary: "Read the deployment",
  description:
    "What this running kobai is: the release of Core it serves, every Workflow it declares with the Step in each position and **where that Step came from**, and whether a Payment Provider is wired. A Step's `origin` is recorded where the rewiring happens rather than inferred — `slot` and `step` are equal for an inserted Step and may be equal for a replacement, so comparing them reads two customised deployments as stock. It deliberately carries neither the Fulfilment Strategies nor the migration sets: `GET /admin/fulfilment-strategies` and `GET /health` already answer those. **This does not page** (ADR-0067). Everything here is decided by a file a Developer edits and a process restart, which is why there is no write half.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.deploymentRead)] as const,
  responses: {
    200: json("What this deployment was configured into.", contract.Deployment),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * This deployment's own OpenAPI description, served.
 *
 * It reverses a sentence Core used to carry, and reads the objection precisely: the objection
 * was to serving the description **anonymously**, and that objection still stands (ADR-0080).
 * `/store` refuses an unauthenticated request before saying whether a path exists, and an open
 * endpoint handing out the whole surface would undo that. Behind a Merchant session and
 * `deployment:read`, a caller has already presented a credential `/store` never accepts.
 *
 * **Serving it rather than bundling it is the decision.** `@kobai/client`'s `schema.ts` is
 * types, erased at build, so the Admin holds no description at runtime at all — and importing
 * `@kobai/core/openapi.json` would ship a *package's* build artifact as though it were a
 * server's answer, in a Project where those are two independently pinned dependencies.
 *
 * **It describes itself**: this path is in the document it returns, which follows from the
 * description being produced from the route table this declaration is registered in.
 */
const readOpenApiDescriptionRoute = createRoute({
  method: "get",
  path: "/openapi.json",
  summary: "Read this deployment's OpenAPI description",
  description:
    "The OpenAPI 3.1 description of the surface **this server** serves, produced from the routes it is built from — so a client reading it is reading this deployment's answer rather than what some package was built with. It describes itself: `/admin/openapi.json` is one of the paths in it. **It is not served anonymously**, and that is a decision rather than an oversight: publishing which routes a deployment serves, which gates they sit behind and which refusals they make is a decision about a Project's exposure that kobai does not take on a Developer's behalf. A Project that wants it public serves it from a route of its own.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.deploymentRead)] as const,
  responses: {
    200: json(
      "This deployment's OpenAPI description, as an OpenAPI 3.1 document.",
      contract.OpenApiDescription,
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
    "A Product, the options it is chosen by, the Variants that make it sellable and the Collections it belongs in, created together in one transaction. There is no route that creates a Product alone, so a Product with no Variant is not a state this API can produce — and `options` is declared here for the same reason, so a Variant naming an option its Product has not declared is not one either. `collections` is here for a different one: grouping a Product is a set this route takes exactly as `PATCH /admin/products/{id}` does, so creating a Product into a Collection is one request rather than two. A `handle` left out is proposed from the title; one that is given is taken as given, and either way one another Product already answers to is refused rather than suffixed. **What this creates is a draft**, always: no Shopper can see it until `PATCH /admin/products/{id}` publishes it, because publishing is a decision rather than a side effect of creating.",
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
      "A Variant names a Fulfilment Strategy this deployment has not wired — Core ships `physical` and `digital`, a Plugin's is wired in the Project's `kobai.config.ts`, and installing the Plugin does not wire it — or a Variant's `options` are not exactly the ones this body declares: `variant-options-mismatch`, naming what it left unanswered and what it named that was never declared — or `collections` names a Collection this Store has not got: `collection-not-found`, naming it, and with nothing written at all.",
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
    "Changes only what is named; a field left out is left alone, and a named `metadata` replaces what is stored rather than merging into it. **This is where a Product is published and where it is archived**, through `status`, and **where its options are renamed, reordered, added and removed**, through `options` — which is the whole list rather than a set of edits, so an entry carrying an `id` is the option that already has it and one this Product has that the list does not name is removed. Adding an option leaves the Variants under it unanswered until each is corrected; removing one is refused where it would leave two Variants answering one combination, naming the two. The title is free to move — an Order's Line Items are a snapshot, so nothing already sold is rewritten (ADR-0009). The handle is free to move too, and that is a different kind of freedom: it is the address a storefront links to, so anything already pointing at the old one stops resolving. **`media` is where images are attached to this Product, reordered on it and detached from it**, and it is the whole list in the order it should be shown in — the first one is the one that leads. Detaching removes the attachment and never the Media: the asset stays in the Store's library and may still be showing on another Product. Variants are not changed here: add one with `POST /admin/products/{id}/variants`, correct one with `PATCH /admin/variants/{id}` — which is also how a Variant is given a value for an option added since it was written, and where a picture is attached to one.",
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
    // two Products share addresses neither, whichever route asked for it (ADR-0060). #277's
    // word joined it there rather than at a 422, on the same argument.
    409: json(
      "`handle-taken`: another Product already answers to that address. Or `variant-combination-taken`: this `options` removes an option two Variants were told apart by, which would leave both answering one combination — the refusal names the two, and correcting or deleting either of them is what lets the correction through.",
      contract.CatalogRefusal,
    ),
    422: json(
      "Well formed, and still refused: `media` names an asset this Store has no Media for (`media-not-found`). Upload it at `POST /admin/media` and attach the identifier that answers with.",
      contract.CatalogRefusal,
    ),
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
      "`sku-taken`: a Variant already carries that SKU, and a SKU identifies one Variant. Or `variant-combination-taken`: a Variant of this Product already answers its options exactly this way, and a storefront maps a combination a Shopper chose to one Variant — the refusal names the Variant holding it, which is what correcting or deleting frees.",
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
    "Changes only what is named; a field left out is left alone. The SKU and the Fulfilment Strategy are both free to move — an Order's Line Items are a snapshot, so nothing already sold is rewritten (ADR-0009) — and a stock count taken for this Variant is left exactly as it is whichever Strategy it now points at. **`options` is where this Variant says what it is** — its value for each option its Product declares — and it **replaces** every value stored rather than merging into them, so it must answer every declared option and only those. That is also how a Variant is given a value for an option declared on the Product since this Variant was written. **`media` is where the picture a Shopper sees when they pick this one is attached**, as the whole list in the order it should be shown in; an empty list detaches everything, and detaching never deletes the Media. A Price is not set here: `POST /admin/variants/{id}/prices` adds one, which supersedes.",
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
      "`sku-taken`: another Variant already carries that SKU, and a SKU identifies one Variant. Or `variant-combination-taken`: another Variant of this Product already answers its options the way this correction asks for — re-sending the combination this Variant already answers is not refused, since a Variant is not its own sibling.",
      contract.CatalogRefusal,
    ),
    422: json(
      "Well formed, and still refused: this deployment has not wired a Fulfilment Strategy of that name — Core ships `physical` and `digital`, and a Plugin's is wired in the Project's `kobai.config.ts` — or the `options` are not exactly the ones this Variant's Product declares (`variant-options-mismatch`), or `media` names an asset this Store has no Media for (`media-not-found`).",
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
 * **What a storefront would be charged for this Variant — asked by a Merchant** (#276).
 *
 * The store surface answers this question too, and only for a Product a Shopper may see: a
 * draft is invisible there, and #276 made that true of the price route as well as of the two
 * catalog reads. That closed a hole and would have taken a capability with it — **previewing an
 * unpublished Product's price is the feature**, since it is how a Merchant checks what a
 * replaced pricing Step will do *before* putting something on sale. So this is the deliberate
 * way through, and four things about it are decisions rather than implementation:
 *
 * - **It runs the deployment's own `resolve-price`, and that is the whole point.** The
 *   declaration is handed in exactly as it is to the store surface (ADR-0017), so a Project that
 *   replaced `select-price` previews the price it will charge. A second implementation of
 *   pricing behind `/admin` would be a preview that could disagree with the storefront, which is
 *   worse than no preview at all — `catalog/a-draft-product-is-not-buyable.test.ts` holds the
 *   two routes to answering identically for a Product that is on sale.
 * - **It answers `ResolvedPrice`, the same schema, `workflow.steps` included.** The Steps that
 *   ran are what let a Developer see that theirs did (spec story 33), and a Merchant looking at
 *   an unexpected number needs that more here than anywhere.
 * - **It is not a privileged capability, and ADR-0010 is untouched.** The Admin still uses only
 *   the public API; what has changed is that the public API now has a route for a question the
 *   store surface cannot honestly answer. A Developer's own tooling may ask it too.
 * - **`catalog:read`**, because a resolved price is catalog data and this reads it — the same
 *   Permission `GET /admin/products/{id}`, which already reports every Price row, sits behind.
 *   A Permission of its own would gate a read behind something narrower than the read it is
 *   derived from.
 *
 * It takes no `?status=`-shaped escape and offers none: it is on the surface a Merchant's
 * session opens, which is what makes asking about a draft here legitimate and asking about one
 * over `/store` not.
 */
const previewPriceRoute = createRoute({
  method: "get",
  path: "/variants/{id}/price",
  summary: "What a storefront would be charged",
  description:
    "Runs this deployment's own `resolve-price` — the same Workflow, the same Steps, the same answer `GET /store/variants/{id}/price` gives — and answers **whatever the Product's status is**. That is what this route is for: a storefront cannot ask about a Product that is not published, and checking a price before putting something on sale is exactly when a Merchant wants to know. The response names the Steps that ran, so a replaced one is visible. Any query string is passed to the Workflow as its open context (ADR-0013), so a Step that reads one can be previewed with it.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogRead)] as const,
  request: { params: contract.IdParam },
  responses: {
    200: json(
      "The resolved Price, and the Steps that produced it.",
      contract.ResolvedPrice,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
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

/**
 * Uploads an image — **the surface's first binary route**, and the only one.
 *
 * Everything else here takes JSON, and this one takes `multipart/form-data` because bytes are
 * what it is for: base64 in a JSON field would be a third more bytes on the wire and would put
 * the whole file through a JSON parser to get it back. The description says so honestly — `file`
 * is `type: string, format: binary`, which is OpenAPI's spelling of a file part — and **the
 * answer is JSON like every other route's**, typechecked by `app.openapi` against
 * `contract.Media` exactly as if the request had been JSON too.
 *
 * It sits behind `catalog:write` because Media *is* catalog data (ADR-0015): the same Permission
 * that lets a Merchant write a Product lets them give it something to show. A Permission of its
 * own would be one the `owner` Role would hold anyway and one every deployment's Roles would
 * have to be taught about.
 *
 * Where the bytes go is `media/storage.ts`'s decision and the deployment's configuration, and
 * this route has no opinion about either — it hands them to whatever `kobai.config.ts` wired
 * and reports back the address that storage gave.
 *
 * ## What it refuses, and where each refusal is made (#278)
 *
 * **A route built per instance, for `sessionSchema`'s reason**: the ceiling and the accepted
 * set are the *deployment's* (`media.maxBytes`, `media.accept`), so this description carries
 * this deployment's own numbers — which is what `GET /admin/openapi.json` then serves to a
 * Developer asking what their Store takes. The route's *shape* does not move with them; only
 * the sentences do, exactly as `Session`'s description carries its idle window.
 *
 * **The size is judged twice and the content type once, and the ordering is the decision.**
 * Both are settled before `MediaStorage.put`, because that interface has no `remove`
 * (ADR-0078): an upload refused after the write leaves bytes no route in kobai can delete.
 *
 * - `refuseDeclaredSize` runs as **middleware, ahead of the body validator**, on the
 *   `Content-Length` the request declared. It is the only check that can prevent what the
 *   ceiling is for — by the time a handler runs, `multipart/form-data` has been parsed and the
 *   whole part is on the heap — and it is deliberately generous, so it can never turn back
 *   something the honest check would take.
 * - `uploadMedia` then judges the bytes it actually has, and the content type the part
 *   declared. This is the half that decides.
 *
 * That middleware is deliberately **not** a gate in `GATE_REFUSALS`' sense, and the distinction
 * is worth keeping: a gate answers a refusal *no handler makes*, which is why a route declaring
 * one is making a claim about its chain. This one answers the identical status, word and body
 * the handler answers a moment later, from the same function in `media/media.ts` — so nothing
 * here is promised that only a middleware can produce, and the route would still refuse
 * `media-too-large` if the middleware were deleted.
 */
function uploadMediaRoute(policy: MediaPolicy) {
  return createRoute({
    method: "post",
    path: "/media",
    summary: "Upload Media",
    description: `A Merchant-supplied catalog asset — a product image and the like (ADR-0015) — sent as \`multipart/form-data\`. kobai stores exactly what it is given: it does not resize, convert or generate thumbnails, so a Store that wants derivatives puts a CDN in front of its \`MediaStorage\`. The width and height on the answer are read out of the file's own header, and are \`null\` for a format kobai cannot read one from. Where the bytes end up is the deployment's — the storage it wired in \`kobai.config.ts\`, or the local-filesystem one kobai ships — and the \`url\` on the answer is that storage's own, so it may be absolute or root-relative.\n\n**This deployment takes files up to ${policy.maxBytes} bytes, of these content types: \`${policy.accept.join("`, `")}\`.** Both are the Project's own (\`media.maxBytes\` and \`media.accept\` in \`kobai.config.ts\`) with kobai's defaults behind them, so another Store's numbers are another Store's; a file over the ceiling is refused \`media-too-large\` and one declaring anything else is refused \`content-type-not-accepted\`, both at 422 and both before a byte is stored. The type judged is the one the file part declares, not one read out of the bytes.`,
    security: MERCHANT_SESSION,
    // The permission first, so a Merchant whose Role cannot write the catalog is told that
    // rather than being told how big this Store's uploads may be.
    middleware: [
      requirePermission(PERMISSIONS.catalogWrite),
      refuseUploadsDeclaringTooMuch(policy),
    ] as const,
    request: {
      body: {
        required: true,
        content: { "multipart/form-data": { schema: contract.UploadMediaRequest } },
      },
    },
    responses: {
      201: json("The Media, and where it is served from.", contract.Media),
      400: json(
        "The request does not fit this endpoint's schema — a body that is not the multipart form this route takes, or a file part with no bytes in it. The other two reasons this schema carries are answered at 422.",
        contract.MediaUploadRefusal,
      ),
      401: REFUSALS.noSession,
      403: REFUSALS.forbidden,
      422: json(
        "Well formed, and still refused by what this deployment will take: the file is over `media.maxBytes` (`media-too-large`), or its declared content type is not in `media.accept` (`content-type-not-accepted`). Both name the limit they were judged against.",
        contract.MediaUploadRefusal,
      ),
      500: REFUSALS.serverError,
      503: REFUSALS.unavailable,
    },
  });
}

/**
 * The declared-size half of the ceiling, as the middleware that answers it.
 *
 * It reads a header and nothing else — no body is touched — which is the whole of its value:
 * the validator behind it is what puts a file on the heap, so this is the last point at which
 * an oversized request costs nothing. `media/media.ts` holds the judgement and the words; this
 * holds only the fact that they are said here.
 *
 * **It answers through `refused` and the same `MEDIA_STATUS` map the handler uses**, which is
 * what makes "the middleware says what the handler would have said" a property of there being
 * one expression rather than of two of them agreeing.
 */
function refuseUploadsDeclaringTooMuch(policy: MediaPolicy): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const refusal = refuseDeclaredSize(c.req.header("content-length"), policy);
    return refusal ? refused(c, refusal, MEDIA_STATUS) : next();
  };
}

const listMediaRoute = createRoute({
  method: "get",
  path: "/media",
  summary: "List Media",
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time — a Merchant listing them has just uploaded one and is looking for it. Ask for more with \`limit\`, and for what follows a page with the \`nextCursor\` it answered; \`nextCursor\` is absent on the last page and that absence is the only end-of-list signal (ADR-0064). This is the only route that enumerates Media: the bytes are served at an unguessable address and nothing there lists anything.`,
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogRead)] as const,
  request: { query: contract.MediaPageQuery },
  responses: {
    200: json("A page of Media.", contract.MediaList),
    400: PAGE_QUERY_INVALID,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * The Collections a Merchant groups Products into (#256, stories 13, 14, 17 and 18).
 *
 * **Behind `catalog:read` and `catalog:write`, and there is deliberately no `collection:` family
 * beside them.** A Collection is catalog data — a Merchant who may write the catalog may group
 * it, and one who may read the catalog may see how it is grouped — so a fifth pair of
 * Permissions would name a boundary that does not exist, which is `role:write`'s argument
 * arriving at a different table (ADR-0066). It also means every deployment that upgrades gets
 * these five routes working, where a new Permission would need a `--custom` migration and would
 * leave a Merchant unable to call them until it ran.
 *
 * **Which Products are in a Collection is not here, in either direction.** There is no `products`
 * on the correction and no `POST /admin/collections/{id}/products`: membership is `collections`
 * on `PATCH /admin/products/{id}`, the whole set of the Collections one Product is in, and
 * `GET /admin/products?collection=` is how the question is asked from this side. Two routes
 * writing one fact would be permanent under ADR-0060 and could disagree about what an empty list
 * means.
 */
const createCollectionRoute = createRoute({
  method: "post",
  path: "/collections",
  summary: "Create a Collection",
  description:
    "A title, and optionally some `metadata`. A Collection starts empty: a Product is put into one with `collections`, which is on `POST /admin/products` and on `PATCH /admin/products/{id}` alike and takes the whole set of the Collections that Product is in. Titles are **not** unique — a Collection is addressed by its identifier everywhere, so two carrying one title are two groupings rather than a collision.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: contract.CreateCollectionRequest } },
    },
  },
  responses: {
    201: json("The Collection.", contract.Collection),
    400: json(
      "The request does not fit this endpoint's schema, or is not JSON at all.",
      contract.CollectionRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const listCollectionsRoute = createRoute({
  method: "get",
  path: "/collections",
  summary: "List Collections",
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time — how a Store's catalog is grouped. Ask for more with \`limit\`, and for what follows a page with the \`nextCursor\` it answered; \`nextCursor\` is absent on the last page and that absence is the only end-of-list signal (ADR-0064). What is *in* one is \`GET /admin/products?collection=\`, which pages the same way.`,
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogRead)] as const,
  request: { query: contract.CollectionPageQuery },
  responses: {
    200: json("A page of Collections.", contract.CollectionList),
    400: PAGE_QUERY_INVALID,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const readCollectionRoute = createRoute({
  method: "get",
  path: "/collections/{id}",
  summary: "Read a Collection",
  description:
    "One Collection. It carries no Products and no count of them: what is in it is `GET /admin/products?collection=`, which pages, where a count beside a title would be a second query over the catalog on every read of every row.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogRead)] as const,
  request: { params: contract.IdParam },
  responses: {
    200: json("The Collection.", contract.Collection),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Collection exists.", contract.CollectionRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const updateCollectionRoute = createRoute({
  method: "patch",
  path: "/collections/{id}",
  summary: "Rename a Collection",
  description:
    "Changes only what is named; a field left out is left alone, and a named `metadata` replaces what is stored rather than merging into it. A body naming nothing this route would change is refused at 400. Which Products are in the Collection is **not** changed here — `collections` on `PATCH /admin/products/{id}` is the whole set of the Collections one Product is in, and it is the only thing that writes a membership.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.UpdateCollectionRequest } },
    },
  },
  responses: {
    200: json("The Collection, as a read of it reports it.", contract.Collection),
    400: json(
      "The request does not fit this endpoint's schema, is not JSON at all, or names nothing this route would change.",
      contract.CollectionRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Collection exists.", contract.CollectionRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Deletes a Collection, and **every Product it held stays exactly where it was** (story 17).
 *
 * **This is the one catalog deletion that refuses nothing**, and the contrast with the two
 * beside it is the decision rather than an oversight. `DELETE /admin/products/{id}` refuses
 * while stock is reserved and `DELETE /admin/roles/{id}` refuses while Merchants hold the Role,
 * because in both cases the delete would take something away from somebody (ADR-0059). Deleting
 * a Collection takes away a *label*: the Products it grouped are still in the catalog, still
 * published, still sellable, and merely ungrouped. Refusing while it held Products would mean a
 * Merchant had to empty a Collection before they could remove it — tidying up in order to delete
 * a name — which is why the cascade stops at the join row rather than reaching a Product.
 */
const deleteCollectionRoute = createRoute({
  method: "delete",
  path: "/collections/{id}",
  summary: "Delete a Collection",
  description:
    "**Deletes the grouping and none of the Products in it.** Every Product it held is still in the catalog, still in whatever other Collections it was in, and merely no longer in this one — so organising is never destructive, and this is refused for nothing but there being no such Collection.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.catalogWrite)] as const,
  request: { params: contract.IdParam },
  responses: {
    204: { description: "Deleted, and every Product it held left alone." },
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Collection exists.", contract.CollectionRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * The Regions this Store sells into (#291, ADR-0005, ADR-0074).
 *
 * **Behind `store:read` and `store:write`, and there is deliberately no `region:` family beside
 * them.** A Region is the Store's own configuration — what a deployment *is*, in the same sense
 * its name and the currency it prices in are — so a fifth pair of Permissions would name a
 * boundary that does not exist, which is `role:write`'s argument at a different table
 * (ADR-0066). It also means every deployment that upgrades gets these five routes working,
 * where a new Permission would need a `--custom` migration and would leave a Merchant unable to
 * call them until it ran. Which gate a route sits behind is promised (ADR-0060), so that is a
 * decision taken here rather than a break to undo later.
 *
 * **A Region selects a currency the Store has enabled**, and both writes refuse
 * `currency-not-enabled` at 422 when it has not — the body is well formed and what refuses it
 * is the state of the Store, which is `unknown-fulfilment-strategy`'s distinction. Enabling one
 * is `currencies` on `PATCH /admin/store`.
 */
const createRegionRoute = createRoute({
  method: "post",
  path: "/regions",
  summary: "Create a Region",
  description:
    "A name and the currency it prices in, which has to be one this Store has enabled — `GET /admin/store` lists them. Names are **not** unique: a Region is addressed by its identifier everywhere. Nothing about tax or shipping is here yet; both hang off this row when they arrive.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeWrite)] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: contract.CreateRegionRequest } },
    },
  },
  responses: {
    201: json("The Region.", contract.Region),
    400: json(
      "The request does not fit this endpoint's schema, or is not JSON at all.",
      contract.RegionRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    422: json(
      "Well formed, and still refused: `currency-not-enabled`, this Store has not enabled that currency.",
      contract.RegionRefusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const listRegionsRoute = createRoute({
  method: "get",
  path: "/regions",
  summary: "List Regions",
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time — the geographies this Store sells into. Ask for more with \`limit\`, and for what follows a page with the \`nextCursor\` it answered; \`nextCursor\` is absent on the last page and that absence is the only end-of-list signal (ADR-0064). Which one a storefront that names none is answered for is \`GET /admin/store\`'s \`defaultRegion\`.`,
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeRead)] as const,
  request: { query: contract.RegionPageQuery },
  responses: {
    200: json("A page of Regions.", contract.RegionList),
    400: PAGE_QUERY_INVALID,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const readRegionRoute = createRoute({
  method: "get",
  path: "/regions/{id}",
  summary: "Read a Region",
  description: "One Region — its name, and the currency it prices in.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeRead)] as const,
  request: { params: contract.IdParam },
  responses: {
    200: json("The Region.", contract.Region),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Region exists.", contract.RegionRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const updateRegionRoute = createRoute({
  method: "patch",
  path: "/regions/{id}",
  summary: "Change a Region",
  description:
    "Changes only what is named; a field left out is left alone, and a named `metadata` replaces what is stored rather than merging into it. A body naming nothing this route would change is refused at 400. **A Region's currency may move**, unlike the Store's: a Region *selects* one of the currencies this Store has enabled, so moving the selection changes which Prices apply here rather than what any amount means.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeWrite)] as const,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.UpdateRegionRequest } },
    },
  },
  responses: {
    200: json("The Region, as a read of it reports it.", contract.Region),
    400: json(
      "The request does not fit this endpoint's schema, is not JSON at all, or names nothing this route would change.",
      contract.RegionRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Region exists.", contract.RegionRefusal),
    422: json(
      "Well formed, and still refused: `currency-not-enabled`, this Store has not enabled that currency.",
      contract.RegionRefusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Deletes a Region, unless this Store falls back to it.
 *
 * **`region-in-use` is ADR-0059's shape**, and the contrast with `DELETE /admin/collections/{id}`
 * is the decision: deleting a Collection takes away a *label*, while deleting the default Region
 * takes away the answer every storefront that sends no `?region=` is given. The repair is a
 * control the Merchant already has — point the Store at another Region, then delete this one —
 * which is exactly the test ADR-0059 applies.
 */
const deleteRegionRoute = createRoute({
  method: "delete",
  path: "/regions/{id}",
  summary: "Delete a Region",
  description:
    "Refused while this is the Store's default Region: `region-in-use`. Point the Store at another one — `defaultRegion` on `PATCH /admin/store` — and send this again.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeWrite)] as const,
  request: { params: contract.IdParam },
  responses: {
    204: { description: "Deleted." },
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Region exists.", contract.RegionRefusal),
    409: json(
      "This Store's default Region is this one, and something has to answer a storefront that names none.",
      contract.RegionRefusal,
    ),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * The Channels this Store sells through (#291, ADR-0005).
 *
 * **Behind `store:read` and `store:write`**, for the Regions' reason above: a Channel is the
 * Store's own configuration.
 *
 * **A Channel is a name and nothing else, and this is the spec most likely to be read as an
 * invitation.** ADR-0005 says kobai's Channel means sales channel only — against Vendure's,
 * which overloads it to mean tenant boundary — so nothing here scopes anything, and the one
 * thing a Channel is joined to is an API key, which is how a request's Channel is decided
 * (ADR-0020) rather than by anything a storefront sends.
 */
const createChannelRoute = createRoute({
  method: "post",
  path: "/channels",
  summary: "Create a Channel",
  description:
    "A name, and optionally some `metadata`. A Channel is a route to market — a storefront, a marketplace listing — and it is **not** a tenant: nothing is scoped by one. Which requests are in it is decided by the API keys minted against it (`POST /admin/api-keys`).",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeWrite)] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: contract.CreateChannelRequest } },
    },
  },
  responses: {
    201: json("The Channel.", contract.Channel),
    400: json(
      "The request does not fit this endpoint's schema, or is not JSON at all.",
      contract.ChannelRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const listChannelsRoute = createRoute({
  method: "get",
  path: "/channels",
  summary: "List Channels",
  description: `Newest first, ${DEFAULT_PAGE_LIMIT} at a time — the routes to market this Store sells through. Ask for more with \`limit\`, and for what follows a page with the \`nextCursor\` it answered; \`nextCursor\` is absent on the last page and that absence is the only end-of-list signal (ADR-0064).`,
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeRead)] as const,
  request: { query: contract.ChannelPageQuery },
  responses: {
    200: json("A page of Channels.", contract.ChannelList),
    400: PAGE_QUERY_INVALID,
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const readChannelRoute = createRoute({
  method: "get",
  path: "/channels/{id}",
  summary: "Read a Channel",
  description:
    "One Channel. It carries no list of the API keys minted against it: which requests are in a Channel is a fact about each key, and `GET /admin/api-keys` reports it.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeRead)] as const,
  request: { params: contract.IdParam },
  responses: {
    200: json("The Channel.", contract.Channel),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Channel exists.", contract.ChannelRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

const updateChannelRoute = createRoute({
  method: "patch",
  path: "/channels/{id}",
  summary: "Rename a Channel",
  description:
    "Changes only what is named; a field left out is left alone, and a named `metadata` replaces what is stored rather than merging into it. A body naming nothing this route would change is refused at 400. Which API keys are in this Channel is **not** changed here — a key is bound to one when it is minted.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeWrite)] as const,
  request: {
    params: contract.IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: contract.UpdateChannelRequest } },
    },
  },
  responses: {
    200: json("The Channel, as a read of it reports it.", contract.Channel),
    400: json(
      "The request does not fit this endpoint's schema, is not JSON at all, or names nothing this route would change.",
      contract.ChannelRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Channel exists.", contract.ChannelRefusal),
    500: REFUSALS.serverError,
    503: REFUSALS.unavailable,
  },
});

/**
 * Deletes a Channel, and **every API key minted against it keeps working**, unconstrained.
 *
 * Refused for nothing but there being no such Channel, which is
 * `DELETE /admin/collections/{id}`'s judgement at a different table. Refusing while keys named
 * it would be worse than useless: revocation is a column rather than a delete, so a revoked key
 * keeps its row forever and a Channel any key had ever named could then never be removed at all
 * — a refusal whose advice names no reachable control.
 */
const deleteChannelRoute = createRoute({
  method: "delete",
  path: "/channels/{id}",
  summary: "Delete a Channel",
  description:
    "**Deletes the Channel and none of the API keys minted against it.** Each of those keys becomes unconstrained — in no particular Channel, which is what every key is until one is minted against one — so this is refused for nothing but there being no such Channel.",
  security: MERCHANT_SESSION,
  middleware: [requirePermission(PERMISSIONS.storeWrite)] as const,
  request: { params: contract.IdParam },
  responses: {
    204: { description: "Deleted, and every key minted against it left working." },
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    404: json("No such Channel exists.", contract.ChannelRefusal),
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
 *
 * **A key carries the Channel every request presenting it is in** (#291, ADR-0005). That is
 * decided here and nowhere else: a storefront never threads a Channel through a request and so
 * cannot claim to be in one it was not issued a credential for. Left out is unconstrained,
 * which is every key that exists today.
 */
const createApiKeyRoute = createRoute({
  method: "post",
  path: "/api-keys",
  summary: "Mint an API key",
  description:
    "The value is in this response and in no other, ever — only a digest is stored. `kobai_pk_…` is publishable and `kobai_sk_…` is secret, so the kind is readable off the value itself. A `channelId` binds every request presenting this key to that Channel; leaving it out mints a key in no particular Channel, which is what every key was before Channels existed.",
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
    400: json(
      "The request does not fit this endpoint's schema, or is not JSON at all.",
      contract.MintApiKeyRefusal,
    ),
    401: REFUSALS.noSession,
    403: REFUSALS.forbidden,
    422: json(
      "Well formed, and still refused: `channel-not-found`, `channelId` names a Channel this Store has not got.",
      contract.MintApiKeyRefusal,
    ),
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

  guarded.openapi(readDeploymentRoute, (c) =>
    c.json(
      describeDeployment({
        version: deps.coreVersion(),
        workflows: deps.workflows,
        paymentProvider: deps.paymentProvider,
      }),
      200,
    ),
  );

  guarded.openapi(readOpenApiDescriptionRoute, (c) => {
    // The very value `kobai.openapi()` produces, which is the whole point: a client reading
    // this is reading what this server serves rather than what a package was built with.
    //
    // The cast is where kobai's types meet OpenAPI's. `OpenAPIObject` is a closed interface
    // with no index signature and this route's schema is deliberately an **open object**
    // (ADR-0080) — modelling a recursive specification kobai does not own would be a second
    // and worse copy of it — so neither type is assignable to the other although both describe
    // the same bytes. Nothing is reshaped here: the same object goes out.
    const document = deps.describeApi() as unknown as Record<string, unknown>;
    return c.json(document, 200);
  });

  guarded.openapi(createProductRoute, async (c) => {
    const created = await createProduct(
      deps.db,
      deps.mediaStorage,
      c.req.valid("json"),
      deps.fulfilment,
    );
    if (!created.ok) return refused(c, created, PRODUCT_STATUS);
    return c.json(created.product, 201);
  });

  guarded.openapi(listProductsRoute, async (c) => {
    const query = c.req.valid("query");

    // **Before the page, so an unknown Collection cannot arrive as a 200 with an empty list** —
    // the filtering convention's second promise, at the first filter whose values a schema
    // cannot hold (#209, #252). `status` is refused by the schema because the schema knows the
    // three words; whether a Collection exists is a fact about the Store.
    if (query.collection !== undefined) {
      const missing = await unknownCollection(deps.db, query.collection);
      if (missing) return refused(c, missing, PAGE_FILTER_STATUS);
    }

    const page = await listProducts(deps.db, deps.mediaStorage, query);
    // `undefined` rather than `null`, and `JSON.stringify` drops the key — which is the wire
    // shape ADR-0064 asks for: absent means there is no further page.
    return c.json({ products: page.items, nextCursor: page.nextCursor }, 200);
  });

  guarded.openapi(readProductRoute, async (c) => {
    const found = await readProduct(deps.db, deps.mediaStorage, c.req.valid("param").id);
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
      deps.mediaStorage,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    if (!corrected.ok) return refused(c, corrected, PRODUCT_UPDATE_STATUS);
    return c.json(corrected.product, 200);
  });

  guarded.openapi(addVariantRoute, async (c) => {
    const added = await addVariant(
      deps.db,
      deps.mediaStorage,
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
      deps.mediaStorage,
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

  guarded.openapi(previewPriceRoute, async (c) => {
    const run = await deps.priceWorkflow.run(
      { variantId: c.req.valid("param").id },
      // **Every key the store surface puts on a Workflow context, and not a subset.** A Step is
      // a Project's to replace and may read any of them, so a route that trimmed the context
      // would be deciding on a Step's behalf which of this deployment's facts it may see — and
      // this route's whole value is answering what the storefront will. The query string is
      // ADR-0013's open half, so a Step that reads a lead time can be previewed with one; there
      // is no body to merge, exactly as on `/store`.
      {
        db: deps.db,
        metadata: openMetadata(new URL(c.req.url)),
        workflows: deps.workflows,
        paymentProvider: deps.paymentProvider,
        fulfilment: deps.fulfilment,
        holdWindowMs: deps.holdWindowMs,
      },
    );

    if (!run.ok) {
      return c.json(
        workflowRefusal(run, deps.priceWorkflow.name),
        priceStatusFor(run.reason),
      );
    }

    // The same expression the store surface answers with, so the preview and the storefront
    // cannot come to two shapes — which is the one thing that would make this route worse than
    // no route at all.
    return c.json(resolvedPriceBody(run, deps.priceWorkflow.name), 200);
  });

  guarded.openapi(uploadMediaRoute(deps.mediaPolicy), async (c) => {
    const form = c.req.valid("form");
    const uploaded = await uploadMedia(deps.db, deps.mediaStorage, deps.mediaPolicy, {
      filename: form.file.name,
      contentType: form.file.type,
      bytes: new Uint8Array(await form.file.arrayBuffer()),
      alt: form.alt,
    });
    if (!uploaded.ok) return refused(c, uploaded, MEDIA_STATUS);
    return c.json(uploaded.media, 201);
  });

  guarded.openapi(listMediaRoute, async (c) => {
    const page = await listMedia(deps.db, deps.mediaStorage, c.req.valid("query"));
    return c.json({ media: page.items, nextCursor: page.nextCursor }, 200);
  });

  guarded.openapi(createCollectionRoute, async (c) => {
    const created = await createCollection(deps.db, c.req.valid("json"));
    if (!created.ok) return refused(c, created, COLLECTION_STATUS);
    return c.json(created.collection, 201);
  });

  guarded.openapi(listCollectionsRoute, async (c) => {
    const page = await listCollections(deps.db, c.req.valid("query"));
    return c.json({ collections: page.items, nextCursor: page.nextCursor }, 200);
  });

  guarded.openapi(readCollectionRoute, async (c) => {
    const found = await readCollection(deps.db, c.req.valid("param").id);
    if (!found) {
      return c.json(
        {
          error:
            "No such Collection exists. `GET /admin/collections` lists the ones this Store has.",
          reason: "collection-not-found" as const,
        },
        404,
      );
    }
    return c.json(found, 200);
  });

  guarded.openapi(updateCollectionRoute, async (c) => {
    const changed = await updateCollection(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    if (!changed.ok) return refused(c, changed, COLLECTION_UPDATE_STATUS);
    return c.json(changed.collection, 200);
  });

  guarded.openapi(deleteCollectionRoute, async (c) => {
    const deleted = await deleteCollection(deps.db, c.req.valid("param").id);
    if (!deleted.ok) return refused(c, deleted, COLLECTION_DELETION_STATUS);
    return c.body(null, 204);
  });

  guarded.openapi(createRegionRoute, async (c) => {
    const created = await createRegion(deps.db, c.req.valid("json"));
    if (!created.ok) return refused(c, created, REGION_STATUS);
    return c.json(created.region, 201);
  });

  guarded.openapi(listRegionsRoute, async (c) => {
    const page = await listRegions(deps.db, c.req.valid("query"));
    return c.json({ regions: page.items, nextCursor: page.nextCursor }, 200);
  });

  guarded.openapi(readRegionRoute, async (c) => {
    const found = await readRegion(deps.db, c.req.valid("param").id);
    if (!found) {
      return c.json(
        {
          error:
            "No such Region exists. `GET /admin/regions` lists the ones this Store has.",
          reason: "region-not-found" as const,
        },
        404,
      );
    }
    return c.json(found, 200);
  });

  guarded.openapi(updateRegionRoute, async (c) => {
    const changed = await updateRegion(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    if (!changed.ok) return refused(c, changed, REGION_UPDATE_STATUS);
    return c.json(changed.region, 200);
  });

  guarded.openapi(deleteRegionRoute, async (c) => {
    const deleted = await deleteRegion(deps.db, c.req.valid("param").id);
    if (!deleted.ok) return refused(c, deleted, REGION_DELETION_STATUS);
    return c.body(null, 204);
  });

  guarded.openapi(createChannelRoute, async (c) => {
    const created = await createChannel(deps.db, c.req.valid("json"));
    if (!created.ok) return refused(c, created, CHANNEL_STATUS);
    return c.json(created.channel, 201);
  });

  guarded.openapi(listChannelsRoute, async (c) => {
    const page = await listChannels(deps.db, c.req.valid("query"));
    return c.json({ channels: page.items, nextCursor: page.nextCursor }, 200);
  });

  guarded.openapi(readChannelRoute, async (c) => {
    const found = await readChannel(deps.db, c.req.valid("param").id);
    if (!found) {
      return c.json(
        {
          error:
            "No such Channel exists. `GET /admin/channels` lists the ones this Store has.",
          reason: "channel-not-found" as const,
        },
        404,
      );
    }
    return c.json(found, 200);
  });

  guarded.openapi(updateChannelRoute, async (c) => {
    const changed = await updateChannel(
      deps.db,
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    if (!changed.ok) return refused(c, changed, CHANNEL_UPDATE_STATUS);
    return c.json(changed.channel, 200);
  });

  guarded.openapi(deleteChannelRoute, async (c) => {
    const deleted = await deleteChannel(deps.db, c.req.valid("param").id);
    if (!deleted.ok) return refused(c, deleted, CHANNEL_DELETION_STATUS);
    return c.body(null, 204);
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
  // 422 for the reason it is 422 at the correction, which is the only other place this word is
  // said about a `collections`: the body is well formed and the state of the Store is what
  // refuses it. One fact, one word, one status, whichever route it is asked at (#280).
  "collection-not-found": 422,
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
  // The set the request named leaves out the code every unconstrained Price is denominated in.
  // 422 for the same reason as the one above it, about the same column from the other end.
  "default-currency-must-be-enabled": 422,
  // …or takes away one a Region selects. Also 422 rather than 409, although another row is what
  // refuses it: this arrives as part of a `PATCH` naming a whole set, so what a Merchant sends
  // again is a *different* body rather than the same one after somebody else moved.
  "currency-in-use": 422,
  // …or the `defaultRegion` names no Region. 422 rather than 404, because the address this
  // request was sent to exists: it is the Store, and what is missing is named inside the body —
  // which is `collection-not-found`'s distinction on `POST /admin/products`.
  "region-not-found": 422,
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
  // 422 for a `media` naming an asset this Store has none of, on
  // `unknown-fulfilment-strategy`'s distinction: the body is well formed and the state of the
  // Store is what refuses it. Not 404 — that belongs to the Product this request addressed and
  // found — and not 409, which would say somebody got there first and invite a retry.
  "media-not-found": 422,
  // 422 again, for a `collections` naming a Collection this Store has none of — the same
  // distinction one noun along, and answered with the word `GET /admin/collections/{id}` uses.
  "collection-not-found": 422,
  // 409, at the status the two Variant routes answer this same word at, and on `handle-taken`'s
  // distinction rather than `media-not-found`'s: what refuses it is a row that already holds
  // the thing being asked for — here a combination rather than an address — and it becomes
  // possible again the moment one of the two Variants named is corrected or deleted, which is a
  // control the Merchant reading the refusal has.
  "variant-combination-taken": 409,
} as const satisfies Record<
  Exclude<ProductUpdate, { ok: true }>["reason"],
  400 | 404 | 409 | 422
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
  // 409 and not 422, which is `sku-taken`'s distinction two lines up and is the same fact one
  // column along: a combination identifies one Variant of a Product exactly as a SKU identifies
  // one Variant of the Store, another row already holds it, and it is free again as soon as
  // that row is corrected or deleted (#277).
  "variant-combination-taken": 409,
} as const satisfies Record<
  Exclude<VariantCreation, { ok: true }>["reason"],
  400 | 404 | 409 | 422
>;

/**
 * Three ways to get an upload wrong, at two statuses, and the split is the usual one.
 *
 * **400 is the request's own fault** — a file part with no bytes in it, which no schema can see
 * is empty. **422 is well formed and still refused**, by what this deployment declared it will
 * take: `unknown-fulfilment-strategy`'s distinction, reached at a different key of the same
 * config file. A 20 MB PNG is a perfectly good request that this Store has said it does not
 * want, and telling a client it was malformed would send them looking at their own code.
 *
 * 413 and 415 were the obvious alternatives and are deliberately not used. This surface answers
 * refusals from a small vocabulary of statuses and a client branches on the `reason` inside
 * them (ADR-0060); two statuses that appear on one route out of forty would buy an exhaustive
 * client two more arms and say nothing the word does not. A 413 from kobai would also be
 * indistinguishable, at the status, from the one a reverse proxy in front of it answers with
 * its own HTML body.
 *
 * There is still no 404 and no 409. Nothing about Media is refused by the *state* of the Store
 * — an asset conflicts with nothing, takes no name anybody else could hold, and is addressed by
 * nothing on the way in.
 */
const MEDIA_STATUS = {
  invalid: 400,
  "media-too-large": 422,
  "content-type-not-accepted": 422,
} as const satisfies Record<
  Exclude<MediaUploadOutcome, { ok: true }>["reason"],
  400 | 422
>;

/**
 * Two ways to get a key wrong: the request's own, and a Channel this Store has not got.
 *
 * 422 for the second on `collection-not-found`'s distinction — the body is well formed and what
 * refuses it is the state of the Store — and it is the same word `GET /admin/channels/{id}`
 * answers 404 with, because one fact gets one word (ADR-0060).
 */
const API_KEY_STATUS = {
  invalid: 400,
  "channel-not-found": 422,
} as const satisfies Record<Exclude<ApiKeyCreation, { ok: true }>["reason"], 400 | 422>;

/**
 * Creating a Region: the body, or a currency this Store has not enabled.
 *
 * 422 rather than 400 for the second, on `unknown-fulfilment-strategy`'s distinction: the code
 * is three letters in the right field and what refuses it is the set the Store has enabled,
 * which `currencies` on `PATCH /admin/store` is how a Merchant widens.
 */
const REGION_STATUS = {
  invalid: 400,
  "currency-not-enabled": 422,
} as const satisfies Record<Exclude<RegionCreation, { ok: true }>["reason"], 400 | 422>;

/** Correcting one: the body, the address, or a currency this Store has not enabled. */
const REGION_UPDATE_STATUS = {
  invalid: 400,
  "region-not-found": 404,
  "currency-not-enabled": 422,
} as const satisfies Record<
  Exclude<RegionUpdate, { ok: true }>["reason"],
  400 | 404 | 422
>;

/**
 * Deleting one: the address, or the Store falling back to it.
 *
 * **409 rather than 422**, on `role-in-use`'s distinction and for its reason: the request is
 * well formed, what refuses it is another row, and it becomes possible by itself the moment
 * that row changes — a Merchant points the Store at another Region and this same request is
 * taken. `role-in-use` is the shape being copied, one noun along (ADR-0059).
 */
const REGION_DELETION_STATUS = {
  "region-not-found": 404,
  "region-in-use": 409,
} as const satisfies Record<Exclude<RegionDeletion, { ok: true }>["reason"], 404 | 409>;

/**
 * Creating a Channel can only be got wrong by the request: a Channel conflicts with nothing,
 * because a name is not unique and it references nothing at all.
 */
const CHANNEL_STATUS = {
  invalid: 400,
} as const satisfies Record<Exclude<ChannelCreation, { ok: true }>["reason"], 400>;

/** Renaming one: the body, or the address. */
const CHANNEL_UPDATE_STATUS = {
  invalid: 400,
  "channel-not-found": 404,
} as const satisfies Record<Exclude<ChannelUpdate, { ok: true }>["reason"], 400 | 404>;

/**
 * Deleting one refuses for exactly one reason, and the absence of any other is the decision.
 *
 * There is no `channel-in-use` beside `region-in-use`: an API key whose Channel has gone is
 * unconstrained rather than broken, and refusing would make a Channel any key had ever named
 * permanently undeletable, since revocation is a column rather than a delete.
 */
const CHANNEL_DELETION_STATUS = {
  "channel-not-found": 404,
} as const satisfies Record<Exclude<ChannelDeletion, { ok: true }>["reason"], 404>;

/**
 * Creating a Collection can only be got wrong by the request: nothing about one conflicts with
 * anything a Store already holds, because a title is not unique.
 */
const COLLECTION_STATUS = {
  invalid: 400,
} as const satisfies Record<Exclude<CollectionCreation, { ok: true }>["reason"], 400>;

/** Renaming one: the body, or the address. */
const COLLECTION_UPDATE_STATUS = {
  invalid: 400,
  "collection-not-found": 404,
} as const satisfies Record<Exclude<CollectionUpdate, { ok: true }>["reason"], 400 | 404>;

/**
 * Deleting one refuses for exactly one reason, and the absence of any other is story 17.
 *
 * There is no `collection-in-use` beside `role-in-use`: a Collection full of Products deletes as
 * cleanly as an empty one, ungrouping them rather than taking anything away.
 */
const COLLECTION_DELETION_STATUS = {
  "collection-not-found": 404,
} as const satisfies Record<Exclude<CollectionDeletion, { ok: true }>["reason"], 404>;

/**
 * A `?collection=` naming no Collection this Store has: **400 and never an empty page.**
 *
 * The filtering convention's second promise, and it is `pageQuery`'s own `invalid` rather than a
 * `reason` of its own — an unusable query parameter does not fit the endpoint, which is what
 * that word already means everywhere on this surface, and a new one would be permanent under
 * ADR-0060 for a distinction no client can act on (`db/page.ts`).
 *
 * Keyed off `NotUsable`'s own union rather than the literal, like every map beside it: the word
 * is `patch.ts`'s, and a rename there has to redden here rather than leave a map agreeing with
 * a string it wrote down itself.
 */
const PAGE_FILTER_STATUS = {
  invalid: 400,
} as const satisfies Record<NotUsable["reason"], 400>;

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
  // 409 wherever a Variant is written, for the reason `VARIANT_CREATION_STATUS` gives: a
  // combination a sibling already answers is `sku-taken`'s shape one column along (#277).
  "variant-combination-taken": 409,
  // 422 at the same status the Product's correction answers it at, because it is one fact about
  // a `media` list and where the list was sent changes neither what is wrong nor how it is
  // fixed — `variant-options-mismatch`'s argument one field along.
  "media-not-found": 422,
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
