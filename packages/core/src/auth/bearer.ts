/**
 * How an API key is presented on a request: `Authorization: Bearer <key>`.
 *
 * The **store** surface's business alone. It was both surfaces' until ADR-0032 moved Merchant
 * sessions into an httpOnly cookie (`session-cookie.ts`), and the argument that kept it here
 * is the one that never applied to the Admin: a key is a server-to-server credential held by
 * a caller in any language, sent deliberately on a request it composed itself, and a header
 * is how that caller has one. What the store gate does with a missing or malformed header is
 * its own business — see `store-gate.ts`.
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
