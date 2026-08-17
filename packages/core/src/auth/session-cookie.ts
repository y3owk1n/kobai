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
 * over the plain HTTP a Developer runs `devbox run up` on — and `__Host-` additionally forces
 * `Path=/`, which is the opposite of what is wanted below. A prefix buys a guarantee against
 * a *sibling origin* overwriting the cookie; local development working at all is worth more,
 * and ADR-0032 records the trade rather than leaving it to be discovered.
 */
export const SESSION_COOKIE = "kobai_session";

/**
 * `Path=/admin`, so the cookie is sent to the admin surface and to nothing else.
 *
 * Path is not a security boundary between origins, and it is not claimed as one. What it does
 * is keep the credential out of requests that have no use for it — `/store`, `/health`, and
 * whatever else a Project serves from the same origin. That is the same argument the cookie
 * itself is here for: a value that never reaches a handler is a value that handler cannot log.
 * It says nothing about the Admin's *own* assets, which ADR-0010 serves at a path this module
 * does not know; if that path turns out to be under `/admin`, they carry the cookie like any
 * other request there.
 *
 * The consequence is worth knowing: kobai's admin surface has to actually be at `/admin`. A
 * Project that mounted `createKobai(...).fetch` under a prefix would sign in successfully and
 * be refused on the very next request — loudly, and at the first attempt, rather than
 * silently and insecurely.
 */
export const SESSION_COOKIE_PATH = "/admin";

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
 * **No `Expires` and no `Max-Age`**, deliberately. A cookie that expired in the browser would
 * simply stop being sent, and the request that followed would be indistinguishable from an
 * anonymous one — the Admin would render an empty page where it should render a sign-in
 * prompt. #4 made "your session ran out" a distinct answer on purpose; leaving the lifetime
 * to the `core_session` row keeps the database the single authority on it, and the gate goes
 * on answering `session-expired` rather than `session-missing` twelve hours later.
 *
 * **`Secure` follows the scheme the request arrived over**, so a deployment behind TLS gets
 * it and `devbox run up` over plain HTTP still works, with nothing to configure in either.
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

function attributes(scheme: Scheme) {
  return {
    httpOnly: true,
    sameSite: "Strict",
    path: SESSION_COOKIE_PATH,
    secure: scheme === "https",
  } as const;
}
