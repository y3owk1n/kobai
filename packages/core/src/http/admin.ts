import { type Context, Hono } from "hono";
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

  admin.route("/", guarded);

  return admin;
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
  return c.json(
    { error: created.detail, reason: created.reason },
    CREATION_STATUS[created.reason],
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
