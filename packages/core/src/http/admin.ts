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
import { createSession, revokeSession } from "../auth/session.ts";
import {
  clearedSessionCookie,
  type Scheme,
  schemeOf,
  sessionCookie,
} from "../auth/session-cookie.ts";
import { listProducts, readProduct } from "../catalog/read.ts";
import {
  createProduct,
  type PriceCreation,
  type ProductCreation,
  setPrice,
} from "../catalog/write.ts";
import type { Database } from "../db/client.ts";
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
};

// ---- The way in --------------------------------------------------------------------------

/** Signs in: exchanges credentials for a session. */
const signInRoute = createRoute({
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
      ...json(
        "Who you now are. The credential itself is in the cookie.",
        contract.Session,
      ),
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

const readSessionRoute = createRoute({
  method: "get",
  path: "/session",
  summary: "Who the caller is",
  description:
    "What the Admin asks first after a page load: who am I, and what may I do.",
  security: MERCHANT_SESSION,
  responses: {
    200: json("The caller's Merchant and Role.", contract.Session),
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

export function createAdminRoutes(deps: AdminDependencies): OpenAPIHono<AdminEnv> {
  const admin = new OpenAPIHono<AdminEnv>({ defaultHook: invalidRequestHook });

  admin.openapi(signInRoute, async (c) => {
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

    const issued = await createSession(deps.db, merchant.id);

    // The credential leaves in a header and not in the body. That is the whole switch: a
    // token in a response body is a token every logging integration is one `JSON.stringify`
    // away from writing down (ADR-0032).
    c.header("set-cookie", sessionCookie(issued.token, scheme(c)));
    return c.json(sessionBody(merchant, merchant.role, issued.expiresAt), 201);
  });

  const guarded = new OpenAPIHono<AdminEnv>({ defaultHook: invalidRequestHook });
  guarded.use("*", requireSession(deps.db));

  guarded.openapi(createMerchantRoute, async (c) => {
    const created = await createMerchant(deps.db, c.req.valid("json"));
    if (!created.ok) return refused(c, created, CREATION_STATUS);
    return c.json(created.merchant, 201);
  });

  guarded.openapi(readSessionRoute, (c) => {
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
    const created = await createProduct(deps.db, c.req.valid("json"));
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

  guarded.openapi(setPriceRoute, async (c) => {
    const created = await setPrice(deps.db, c.req.valid("param").id, c.req.valid("json"));
    if (!created.ok) return refused(c, created, PRICE_STATUS);
    return c.json(created.price, 201);
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

/** 400 for a request that is wrong, 409 for one another row already answered. */
const PRODUCT_STATUS = {
  invalid: 400,
  "sku-taken": 409,
} as const satisfies Record<Exclude<ProductCreation, { ok: true }>["reason"], 400 | 409>;

/** Only one way to get a key wrong, and it is the request's fault. */
const API_KEY_STATUS = {
  invalid: 400,
} as const satisfies Record<Exclude<ApiKeyCreation, { ok: true }>["reason"], 400>;

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
