/**
 * How a credential is presented on a request: `Authorization: Bearer <token>`.
 *
 * One parser, because kobai has two authenticated surfaces and they should disagree about
 * *which* credential they accept, never about how one arrives. What each surface does with a
 * missing or malformed header is its own business — see `gate.ts` and `store-gate.ts`.
 */

const SCHEME = "bearer";

export type BearerToken =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: "missing" | "malformed" };

export function bearerToken(header: string | undefined): BearerToken {
  if (header === undefined) return { ok: false, reason: "missing" };

  const parts = header.trim().split(/\s+/);
  const [scheme, token] = parts;
  if (scheme?.toLowerCase() !== SCHEME || parts.length !== 2 || !token) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, token };
}
