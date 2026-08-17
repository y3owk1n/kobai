import type { Context, MiddlewareHandler } from "hono";
import type { Database } from "../db/client.ts";
import { GATE_REFUSALS, gateAnswering } from "../http/gate-refusals.ts";
import {
  type ApiKeyRejection,
  type AuthenticatedApiKey,
  resolveApiKey,
} from "./api-key.ts";
import { bearerToken } from "./bearer.ts";

/**
 * The gate on the **store surface**.
 *
 * A second gate, not a second credential for the first one. The admin gate asks *which
 * Merchant is this, and does their Role hold this permission*; this one asks *is this a live
 * API key*, and stops there — a key authenticates a deployment rather than a person, and
 * carries no Role for a permission to be looked up in (ADR-0020).
 *
 * Keeping them apart is the security property. If the store surface were the admin gate with
 * a wider notion of "credential", every route added under `/admin` would be one mistake away
 * from being reachable by a storefront. As it is, a key presented to `/admin` is not a
 * session and is refused there, and a session presented to `/store` is not a key and is
 * refused here — and since ADR-0032 they do not even arrive the same way, because a session
 * is a cookie and this gate reads `Authorization`.
 *
 * ```ts
 * const store = new Hono<StoreEnv>();
 * store.use("*", requireApiKey(db));
 * ```
 *
 * The guard goes on the sub-app rather than on each route, for the reason the admin gate's
 * does: a route added there is authenticated by construction, and the surface is closed by
 * default and opened one route at a time.
 *
 * Both kinds of key open it. A publishable key is the one a browser holds, and a price is
 * what a browser is allowed to know — which is what a publishable key is *for*. A route that
 * one day needs more than that reads `c.get("apiKey").kind` and says so itself; there is no
 * per-kind machinery here, because inventing one before a route needs it would fix its shape
 * by guesswork.
 */

/** Hono's typing for the store sub-app: `c.get("apiKey")` is available below the gate. */
export type StoreEnv = { Variables: { apiKey: AuthenticatedApiKey } };

/**
 * Built through `gateAnswering`, like the admin gate: the middleware carries the refusal it
 * makes, so a `/store` route declaring a `401` it is not behind — or sitting behind this and
 * declaring none — fails the build. See `http/gate-refusals.ts`.
 */
export function requireApiKey(db: Database): MiddlewareHandler<StoreEnv> {
  return gateAnswering(GATE_REFUSALS.noApiKey, async (c, next) => {
    const presented = bearerToken(c.req.header("authorization"));
    if (!presented.ok) return refuse(c, presented.reason);

    const lookup = await resolveApiKey(db, presented.token);
    if (!lookup.ok) return refuse(c, lookup.reason);

    c.set("apiKey", lookup.apiKey);
    await next();
  });
}

/**
 * Every refusal is a 401 carrying a machine-readable `reason`, in the shape every other
 * kobai refusal uses.
 *
 * The four reasons are kept apart because they have different fixes: a key that was never
 * sent, a string that is not a kobai key at all, a key nobody issued, and a key that was
 * revoked. Collapsing them into "unauthorised" would make the commonest support question —
 * *why has my storefront stopped working* — unanswerable from the response.
 */
function refuse(c: Context<StoreEnv>, reason: ApiKeyRejection) {
  return c.json(
    { error: REFUSAL[reason], reason: `api-key-${reason}` },
    401,
    // RFC 6750: name the scheme the request failed to satisfy rather than making a client
    // guess at it.
    { "www-authenticate": "Bearer" },
  );
}

const REFUSAL = {
  missing:
    "This endpoint requires an API key. Send `Authorization: Bearer <key>`, and create a key from the Admin.",
  malformed:
    "That is not a kobai API key. A key looks like `kobai_pk_…` if it is publishable or `kobai_sk_…` if it is secret. A Merchant session opens the admin surface and not this one, and it is a cookie rather than anything that could arrive here.",
  unknown: "This API key does not exist. Create one from the Admin.",
  revoked: "This API key has been revoked. Create a new one from the Admin.",
} as const satisfies Record<ApiKeyRejection, string>;
