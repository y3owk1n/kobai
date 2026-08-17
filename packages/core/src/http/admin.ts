import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type AdminEnv,
  authenticated,
  authorise,
  requirePermission,
  requireSession,
} from "../auth/gate.ts";
import type { MerchantIdentity, RoleSummary } from "../auth/identity.ts";
import {
  type MerchantCreation,
  authenticateMerchant,
  createMerchant,
  hasAnyMerchant,
} from "../auth/merchant.ts";
import { PERMISSIONS } from "../auth/permissions.ts";
import { createSession, revokeSession } from "../auth/session.ts";
import { listProducts, readProduct } from "../catalog/read.ts";
import {
  type PriceCreation,
  type ProductCreation,
  createProduct,
  setPrice,
} from "../catalog/write.ts";
import type { Database } from "../db/client.ts";
import { readStore } from "../store/read.ts";

/**
 * The admin surface — everything a Merchant reaches, and the only thing the Admin consumes
 * (ADR-0010). There is no privileged back door here for it to use instead.
 *
 * It is in two halves, and the split is the security property:
 *
 * - **the way in**, which cannot require a session, because one route mints the very first
 *   Merchant and the other mints the session itself;
 * - **everything else**, on a sub-app carrying `requireSession`, so a route added there is
 *   authenticated by construction and each route names the one permission it needs.
 *
 * Registration order matters — the way in is registered first, so its handlers answer before
 * the guard below them is reached. Each of those two routes has a test that calls it with no
 * `Authorization` header, and every other route has one asserting the opposite.
 */

export type AdminDependencies = {
  readonly db: Database;
};

export function createAdminRoutes(deps: AdminDependencies): Hono<AdminEnv> {
  const admin = new Hono<AdminEnv>();

  // ---- The way in ------------------------------------------------------------------------

  /**
   * Creates a Merchant.
   *
   * Normally this needs `merchant:write`, like any other change to the deployment. The one
   * exception is a deployment holding no Merchant at all: nobody could hold the permission,
   * so requiring it unconditionally would leave the Admin permanently unreachable. The first
   * Merchant therefore claims the deployment — and claiming it is possible exactly once, so
   * from the second request onwards this route behaves like every other guarded one.
   */
  admin.post("/merchants", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return c.json(body.error, 400);

    // An `Authorization` header means the caller is claiming to be somebody, so take them at
    // their word and hold them to it — the bootstrap path is for a caller with no session on
    // a deployment with no Merchant, and nothing else.
    const bootstrap =
      c.req.header("authorization") === undefined && !(await hasAnyMerchant(deps.db));

    if (!bootstrap) {
      const gate = await authorise(
        deps.db,
        c.req.header("authorization"),
        PERMISSIONS.merchantWrite,
      );
      if (!gate.ok) return c.json(gate.body, gate.status, gate.headers);
    }

    return respondToCreation(c, await createMerchant(deps.db, body.value, { bootstrap }));
  });

  /** Signs in: exchanges credentials for a session. */
  admin.post("/session", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return c.json(body.error, 400);

    const merchant = await authenticateMerchant(
      deps.db,
      body.value.email,
      body.value.password,
    );
    if (!merchant) {
      // One answer for an unknown address and for a wrong password. Distinguishing them would
      // turn this endpoint into a way to ask who works here.
      return c.json(
        { error: "Those credentials are not valid.", reason: "invalid-credentials" },
        401,
      );
    }

    const issued = await createSession(deps.db, merchant.id);
    return c.json(
      {
        token: issued.token,
        ...sessionBody(merchant, merchant.role, issued.expiresAt),
      },
      201,
    );
  });

  // ---- Everything else -------------------------------------------------------------------

  const guarded = new Hono<AdminEnv>();
  guarded.use("*", requireSession(deps.db));

  /** Who the caller is and what they may do — the Admin's first call after a page load. */
  guarded.get("/session", (c) => {
    const auth = authenticated(c);
    return c.json(sessionBody(auth.merchant, auth.role, auth.expiresAt), 200);
  });

  /** Signs out. The row goes, so the token stops working on the very next request. */
  guarded.delete("/session", async (c) => {
    await revokeSession(deps.db, authenticated(c).sessionId);
    return c.body(null, 204);
  });

  guarded.get("/store", requirePermission(PERMISSIONS.storeRead), async (c) => {
    const store = await readStore(deps.db);
    if (!store) {
      return c.json(
        { error: "No Store exists. The database is migrated but unseeded." },
        500,
      );
    }
    return c.json(store, 200);
  });

  /**
   * Creates a Product and the Variants that make it sellable, in one transaction.
   *
   * There is deliberately no route that creates a Product on its own. A Product is never
   * sellable in itself (ADR-0008), so one with no Variant is a catalog entry nothing can buy
   * — and the cheapest way to guarantee that state never exists is to give the API no way to
   * reach it, rather than to detect and repair it afterwards.
   */
  guarded.post("/products", requirePermission(PERMISSIONS.catalogWrite), async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return c.json(body.error, 400);

    const created = await createProduct(deps.db, body.value);
    if (!created.ok) return refused(c, created, PRODUCT_STATUS);
    return c.json(created.product, 201);
  });

  /** Every Product, so a Merchant can confirm the one they just made is there. */
  guarded.get("/products", requirePermission(PERMISSIONS.catalogRead), async (c) => {
    return c.json({ products: await listProducts(deps.db) }, 200);
  });

  /** One Product, with its Variants and each Variant's Prices. */
  guarded.get("/products/:id", requirePermission(PERMISSIONS.catalogRead), async (c) => {
    const found = await readProduct(deps.db, c.req.param("id"));
    if (!found) {
      return c.json(
        { error: "No such Product exists.", reason: "product-not-found" },
        404,
      );
    }
    return c.json(found, 200);
  });

  /**
   * Adds a Price to a Variant — an insert, never an update.
   *
   * The Variant is what the route addresses because the Variant is what is sellable. Calling
   * this twice leaves a Variant with two Prices rather than one overwritten one, which is
   * ADR-0008's shape working: sale prices, further currencies and quantity breaks are more
   * rows here, not a migration.
   */
  guarded.post(
    "/variants/:id/prices",
    requirePermission(PERMISSIONS.catalogWrite),
    async (c) => {
      const body = await jsonBody(c);
      if (!body.ok) return c.json(body.error, 400);

      const created = await setPrice(deps.db, c.req.param("id"), body.value);
      if (!created.ok) return refused(c, created, PRICE_STATUS);
      return c.json(created.price, 201);
    },
  );

  admin.route("/", guarded);

  return admin;
}

/** 400 for a request that is wrong, 409 for one another row already answered. */
const PRODUCT_STATUS = {
  invalid: 400,
  "sku-taken": 409,
} as const satisfies Record<Exclude<ProductCreation, { ok: true }>["reason"], 400 | 409>;

/** 422 for a currency this Store does not price in: well-formed, and still refused. */
const PRICE_STATUS = {
  invalid: 400,
  "unsupported-currency": 422,
  "variant-not-found": 404,
} as const satisfies Record<
  Exclude<PriceCreation, { ok: true }>["reason"],
  400 | 404 | 422
>;

/** One shape for "you are signed in", whether it is being issued or merely reported. */
function sessionBody(merchant: MerchantIdentity, role: RoleSummary, expiresAt: Date) {
  return {
    expiresAt: expiresAt.toISOString(),
    merchant: { id: merchant.id, email: merchant.email },
    role: { name: role.name, permissions: role.permissions },
  };
}

/**
 * 400 when the request was wrong, 409 when the deployment's state is what refuses it — the
 * distinction between "fix your request" and "somebody got there first".
 */
const CREATION_STATUS = {
  invalid: 400,
  "unknown-role": 400,
  "email-taken": 409,
  "already-claimed": 409,
} as const satisfies Record<Exclude<MerchantCreation, { ok: true }>["reason"], 400 | 409>;

function respondToCreation(c: Context<AdminEnv>, created: MerchantCreation) {
  if (created.ok) return c.json(created.merchant, 201);
  return refused(c, created, CREATION_STATUS);
}

/**
 * One shape for every refusal this surface makes: `{ error, reason }`, at the status its
 * reason names.
 *
 * The gate answers in that shape (`auth/gate.ts`), so everything below it answers in the same
 * one — a client parses refusals one way whether it was turned back at the door or by the
 * handler. The status map is passed in rather than switched on here, so a module that grows a
 * reason has one place to say what it means and the compiler asks for it: `satisfies Record<…>`
 * on each map makes an unmapped reason a build failure rather than an `undefined` status.
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

type JsonBody =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: Record<string, string> };

/**
 * Reads a JSON object body, turning a malformed one into a 400 rather than a 500: Hono's
 * `req.json()` throws, and an unparseable body is the client's mistake, not the server's.
 */
async function jsonBody(c: Context<AdminEnv>): Promise<JsonBody> {
  const malformed = {
    ok: false,
    error: { error: "The request body must be a JSON object.", reason: "malformed-body" },
  } as const;

  try {
    const value: unknown = await c.req.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return malformed;
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return malformed;
  }
}
