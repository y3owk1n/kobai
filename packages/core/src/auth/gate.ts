import type { Context, MiddlewareHandler } from "hono";
import type { Database } from "../db/client.ts";
import { bearerToken } from "./bearer.ts";
import type { Permission } from "./permissions.ts";
import {
  type Authenticated,
  holdsPermission,
  resolveSession,
  type SessionRejection,
} from "./session.ts";

/**
 * The gate on the admin surface.
 *
 * One question is asked, once, before a handler runs: *is this a live session, and does its
 * Role hold this permission?* A permission is a string in a set on the Role (ADR-0027) — the
 * gate never walks the resources the handler is about to touch, and no handler checks access
 * row by row.
 *
 * ```ts
 * const guarded = new Hono<AdminEnv>();
 * guarded.use("*", requireSession(db));
 * guarded.get("/store", requirePermission(PERMISSIONS.storeRead), (c) => …);
 * ```
 *
 * `requireSession` goes on the sub-app rather than on each route on purpose: a route added
 * there is authenticated by construction, and a route that must be reachable *without* a
 * session has to be moved somewhere visibly different rather than merely forgetting to
 * decorate it. The admin surface is closed by default and opened one route at a time.
 */

/** Hono's typing for the guarded sub-app: `c.get("auth")` is available below the gate. */
export type AdminEnv = { Variables: { auth: Authenticated } };

/**
 * Why the gate said no, ready to be sent. 401 when nobody is asking, 403 when somebody is and
 * their Role does not hold the permission — the distinction a client needs to decide between
 * "sign in" and "ask an owner".
 */
export type Refusal = {
  readonly ok: false;
  readonly status: 401 | 403;
  readonly body: Record<string, unknown>;
  readonly headers?: Record<string, string>;
};

export type Authorisation = { readonly ok: true; readonly auth: Authenticated } | Refusal;

/**
 * The gate itself, as an ordinary function — the middlewares below are this, wired into Hono.
 *
 * It is exported because one route genuinely cannot be middleware-guarded: creating the
 * *first* Merchant has to work with no session at all, so that handler decides for itself and
 * then calls this. See `http/admin.ts`.
 */
export async function authorise(
  db: Database,
  authorization: string | undefined,
  permission?: Permission,
): Promise<Authorisation> {
  const token = bearerToken(authorization);
  if (!token.ok) return refusal(token.reason);

  const lookup = await resolveSession(db, token.token);
  if (!lookup.ok) return refusal(lookup.reason);

  if (permission !== undefined && !holdsPermission(lookup.auth, permission)) {
    return denial(lookup.auth, permission);
  }

  return { ok: true, auth: lookup.auth };
}

export function requireSession(db: Database): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const result = await authorise(db, c.req.header("authorization"));
    if (!result.ok) return c.json(result.body, result.status, result.headers);

    c.set("auth", result.auth);
    await next();
  };
}

/** Only usable below {@link requireSession}, which is what puts `auth` on the context. */
export function requirePermission(permission: Permission): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const auth = authenticated(c);
    if (!holdsPermission(auth, permission)) {
      const result = denial(auth, permission);
      return c.json(result.body, result.status);
    }
    await next();
  };
}

/**
 * The Merchant behind the current request. Only callable below {@link requireSession}.
 *
 * A route reached without the gate in front of it throws rather than reading an absent
 * Merchant as an unprivileged one — the difference between a 500 with a legible reason and a
 * route that silently answers everybody.
 */
export function authenticated(c: Context<AdminEnv>): Authenticated {
  const auth = c.get("auth");
  if (!auth) {
    throw new Error(
      "This route was reached without `requireSession` in front of it, so there is no Merchant on the request. Mount it on the guarded sub-app in http/admin.ts.",
    );
  }
  return auth;
}

/**
 * Every unauthenticated refusal is a 401 carrying a machine-readable `reason`.
 *
 * `session-expired` is deliberately distinguishable from `session-missing`: a Merchant whose
 * session ran out has been signed *out*, and the Admin should say so rather than render the
 * empty page an anonymous request would get. The row is already gone by this point —
 * `resolveSession` deletes it — so the sign-out is real and not merely reported.
 */
function refusal(reason: SessionRejection): Refusal {
  return {
    ok: false,
    status: 401,
    body: { error: REFUSAL[reason], reason: `session-${reason}` },
    // RFC 6750: name the scheme the request failed to satisfy rather than making a client
    // guess at it.
    headers: { "www-authenticate": "Bearer" },
  };
}

function denial(auth: Authenticated, permission: Permission): Refusal {
  return {
    ok: false,
    status: 403,
    body: {
      error: `The role ${JSON.stringify(auth.role.name)} does not hold ${permission}.`,
      reason: "permission-denied",
      required: permission,
    },
  };
}

const REFUSAL = {
  missing:
    "This endpoint requires a Merchant session. Sign in at POST /admin/session and send `Authorization: Bearer <token>`.",
  malformed:
    "The Authorization header is not a bearer token. Send `Authorization: Bearer <token>`.",
  unknown: "This session does not exist. Sign in again at POST /admin/session.",
  expired: "This session has expired and you have been signed out. Sign in again.",
} as const satisfies Record<SessionRejection, string>;
