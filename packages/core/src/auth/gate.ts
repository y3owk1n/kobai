import type { Context, Env, MiddlewareHandler } from "hono";
import type { Database } from "../db/client.ts";
import { GATE_REFUSALS, gateAnswering } from "../http/gate-refusals.ts";
import type { Permission } from "./permissions.ts";
import {
  type Authenticated,
  holdsPermission,
  resolveSession,
  type SessionRejection,
} from "./session.ts";
import { presentedSessionToken } from "./session-cookie.ts";

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
 *
 * The two are separate types rather than one with a widened `body`, because they carry
 * different fields and the OpenAPI description promises which arrives with which status. A
 * `Record<string, unknown>` here would make that promise uncheckable at the point it is kept.
 */
export type SessionRefused = {
  readonly ok: false;
  readonly status: 401;
  readonly body: {
    readonly error: string;
    readonly reason: `session-${SessionRejection}`;
  };
};

export type PermissionRefused = {
  readonly ok: false;
  readonly status: 403;
  readonly body: {
    readonly error: string;
    readonly reason: "permission-denied";
    readonly required: Permission;
  };
};

export type Refusal = SessionRefused | PermissionRefused;

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
  cookieHeader: string | undefined,
  permission?: Permission,
): Promise<Authorisation> {
  const token = presentedSessionToken(cookieHeader);
  if (!token.ok) return refusal(token.reason);

  const lookup = await resolveSession(db, token.token);
  if (!lookup.ok) return refusal(lookup.reason);

  if (permission !== undefined && !holdsPermission(lookup.auth, permission)) {
    return denial(lookup.auth, permission);
  }

  return { ok: true, auth: lookup.auth };
}

/**
 * Sends a refusal.
 *
 * Branched rather than passed through as `(body, status)` because the two carry different
 * shapes, and the OpenAPI description promises which arrives with which status. Handing
 * `c.json` a union of bodies and a union of statuses would lose the pairing at exactly the
 * point the promise is kept, so a route's declaration could no longer be checked against it.
 *
 * Generic over the environment so both the middleware below and the one handler that gates
 * itself — `POST /admin/merchants`, which mints the first Merchant — can use it.
 */
export function refuse<E extends Env>(c: Context<E>, refusal: Refusal) {
  return refusal.status === 401 ? c.json(refusal.body, 401) : c.json(refusal.body, 403);
}

/**
 * Both gates are built through `gateAnswering`, which marks the middleware with the refusal
 * it makes so that `openapi.test.ts` can hold a route's declaration to its actual chain — a
 * declared `401` or `403` with no gate behind it, or a gate whose route declared neither,
 * fails the build. The mark is put on here rather than at the mounting site so that there is
 * no unmarked gate to mount by accident. See `http/gate-refusals.ts`.
 */
export function requireSession(db: Database): MiddlewareHandler<AdminEnv> {
  return gateAnswering(GATE_REFUSALS.noSession, async (c, next) => {
    // No permission is asked for here, so only the 401 arm is ever reachable.
    const result = await authorise(db, c.req.header("cookie"));
    if (!result.ok) return refuse(c, result);

    c.set("auth", result.auth);
    await next();
  });
}

/** Only usable below {@link requireSession}, which is what puts `auth` on the context. */
export function requirePermission(permission: Permission): MiddlewareHandler<AdminEnv> {
  return gateAnswering(GATE_REFUSALS.forbidden, async (c, next) => {
    const auth = authenticated(c);
    if (!holdsPermission(auth, permission)) {
      return c.json(denial(auth, permission).body, 403);
    }
    await next();
  });
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
 * empty page an anonymous request would get. That distinction is why the cookie carries no
 * `Expires` of its own — a cookie the browser dropped would arrive as `session-missing`, and
 * the browser would have overruled the answer this surface exists to give.
 *
 * There is deliberately no `WWW-Authenticate` here, and the store gate still sends one. RFC
 * 6750's challenge names the scheme a request failed to satisfy; this surface is opened by a
 * cookie, so naming `Bearer` would be an instruction a client cannot act on.
 */
function refusal(reason: SessionRejection): SessionRefused {
  return {
    ok: false,
    status: 401,
    body: { error: REFUSAL[reason], reason: `session-${reason}` },
  };
}

function denial(auth: Authenticated, permission: Permission): PermissionRefused {
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
    "This endpoint requires a Merchant session. Sign in at POST /admin/session; the session comes back as a `kobai_session` cookie, which a browser then sends by itself.",
  malformed:
    "The `kobai_session` cookie carries no session token. Sign in again at POST /admin/session.",
  unknown: "This session does not exist. Sign in again at POST /admin/session.",
  expired: "This session has expired and you have been signed out. Sign in again.",
} as const satisfies Record<SessionRejection, string>;
