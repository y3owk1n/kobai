import { parse, serialize } from "hono/utils/cookie";

/**
 * How a Merchant session travels: an httpOnly cookie, set at sign-in and cleared at sign-out.
 *
 * A cookie rather than `Authorization: Bearer` because the token is then never a value any
 * part of the system can print. A bearer token has to be handed to the client in a response
 * body and handed back in a header, so every logging integration anyone ever adds is one
 * `JSON.stringify` away from writing a live credential to disk. An httpOnly cookie is written
 * once, by the browser, and read once, by the gate — script cannot reach it and no response
 * body carries it. See ADR-0032.
 *
 * The store surface is untouched by any of this. An API key is a server-to-server credential
 * for a caller in any language and stays `Authorization: Bearer kobai_pk_… | kobai_sk_…`
 * (`bearer.ts`, `store-gate.ts`); this module is the admin surface's business alone.
 */

/**
 * The cookie's name, and no `__Host-`/`__Secure-` prefix on it.
 *
 * Both prefixes make `Secure` mandatory, which would mean the cookie could not be set at all
 * over the plain HTTP a Developer runs `pnpm run up` on — and `__Host-` additionally forces
 * `Path=/`, which is the opposite of the scoping described below. A prefix buys a guarantee
 * against a *sibling origin* overwriting the cookie; local development working at all is
 * worth more, and ADR-0032 records the trade rather than leaving it to be discovered.
 */
export const SESSION_COOKIE = "kobai_session";

/** Which scheme a request arrived over — the one thing `Secure` depends on. */
export type Scheme = "http" | "https";

export type PresentedSession =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: "missing" | "malformed" };

/**
 * Reads the session token off a request's `Cookie` header.
 *
 * The two refusals keep the meanings `bearer.ts` gave them, because the Admin acts on them:
 * `missing` is nobody asking — no cookie was sent, which is what an anonymous request and a
 * signed-out browser both look like — and `malformed` is the cookie being present and
 * carrying nothing usable.
 */
export function presentedSessionToken(
  cookieHeader: string | undefined,
): PresentedSession {
  if (cookieHeader === undefined) return { ok: false, reason: "missing" };

  const token = parse(cookieHeader, SESSION_COOKIE)[SESSION_COOKIE];
  if (token === undefined) return { ok: false, reason: "missing" };
  if (token.trim() === "") return { ok: false, reason: "malformed" };

  return { ok: true, token };
}

/**
 * The `Set-Cookie` that carries a freshly issued session.
 *
 * **`SameSite=Strict`.** ADR-0010 puts the Admin in the same container as the API, so every
 * request the Admin makes is same-site by construction and `Strict` costs it nothing: a
 * cross-site link into the Admin loads the SPA's HTML, which needs no credential, and every
 * call the SPA then makes is same-site and carries the cookie normally. Nothing in kobai
 * enters the admin surface from another site — there is no SSO callback, no payment return,
 * no magic link — so `Lax`'s allowance for top-level GET navigations would be a hole kept
 * open for a flow that does not exist.
 *
 * **`HttpOnly`**, so script cannot read it, which is the property the switch was made for.
 *
 * **No `Path` at all**, which is how the cookie follows wherever a Project mounted Core. A
 * `Set-Cookie` that names no `Path` is filed by the browser under RFC 6265's *default-path*:
 * the directory of the URI it arrived from. Signing in at `/admin/session` scopes it to
 * `/admin`; signing in at `/api/admin/session` scopes it to `/api/admin`. Both are the admin
 * surface of that deployment and neither reaches `/store` or `/health`.
 *
 * Naming a `Path` here cannot do that, and the reason is worth keeping: Core hands back a
 * `fetch` for the Project to bind (ADR-0031), and a Project is equally free to mount it under
 * a prefix. A Hono `mount` — like a reverse proxy that rewrites a prefix away — strips that
 * prefix *before* Core sees the request. Core is handed `/admin/session` either way, so the
 * prefix is not a fact any handler here can read. The browser is the one party that knows the
 * URI it asked for, so the browser is what computes the scope. See ADR-0032.
 *
 * **No `Expires` and no `Max-Age`**, deliberately. A cookie that expired in the browser would
 * simply stop being sent, and the request that followed would be indistinguishable from an
 * anonymous one — the Admin would render an empty page where it should render a sign-in
 * prompt. #4 made "your session ran out" a distinct answer on purpose; leaving the lifetime
 * to the `core_session` row keeps the database the single authority on it, and the gate goes
 * on answering `session-expired` rather than `session-missing` when the window runs out.
 *
 * Since ADR-0045 that window *moves* — a request extends it — which is a second reason the
 * attributes are absent rather than merely unnecessary. A browser-side expiry would have to
 * be rewritten on every response to keep step with the row, and any response that failed to
 * would drop a live session's cookie.
 *
 * **`Secure` follows the scheme the request arrived over**, so a deployment behind TLS gets
 * it and `pnpm run up` over plain HTTP still works, with nothing to configure in either.
 */
export function sessionCookie(token: string, scheme: Scheme): string {
  return serialize(SESSION_COOKIE, token, attributes(scheme));
}

/**
 * The `Set-Cookie` that removes it.
 *
 * Every attribute matches {@link sessionCookie}'s: a browser matches a deletion to a stored
 * cookie by name, domain and path, so a clear that disagreed about `Path` would leave the old
 * cookie in place and sign-out would only look like it had worked.
 *
 * With no `Path` on either, that agreement is structural rather than maintained. Both cookies
 * are computed from the URI they arrived from, and both arrive at `…/admin/session` — the
 * same URI, since sign-in and sign-out are the same route under different methods. There is
 * no second constant to keep in step, at any mount depth.
 */
export function clearedSessionCookie(scheme: Scheme): string {
  return serialize(SESSION_COOKIE, "", { ...attributes(scheme), maxAge: 0 });
}

/**
 * Which scheme the request arrived over, honouring `X-Forwarded-Proto`.
 *
 * The header is trusted because the alternative is worse. kobai is deployed as one container
 * (ADR-0010) and TLS is almost always terminated in front of it, so a process that judged
 * only by its own socket would decide "plain HTTP" in production and drop `Secure` from every
 * cookie it set. Lying in the header costs the liar their own cookie and nobody else theirs:
 * a browser cannot be made to add this header to a cross-origin request, so it cannot be used
 * to strip `Secure` from somebody else's session.
 */
export function schemeOf(url: string, forwardedProto: string | undefined): Scheme {
  const forwarded = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (forwarded !== undefined && forwarded !== "") {
    return forwarded === "https" ? "https" : "http";
  }
  return new URL(url).protocol === "https:" ? "https" : "http";
}

/**
 * Every attribute both cookies carry, in one place, so the clear cannot drift from the set.
 *
 * **No `path`.** RFC 6265 then files the cookie under the directory of the URI it was set
 * from — `/admin` when Core is mounted at the root, `/api/admin` when a Project mounted it at
 * `/api` — and sends it back to exactly that subtree. See {@link sessionCookie}.
 */
function attributes(scheme: Scheme) {
  return {
    httpOnly: true,
    sameSite: "Strict",
    secure: scheme === "https",
  } as const;
}
