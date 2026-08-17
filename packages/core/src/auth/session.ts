import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { merchant, role, session } from "../db/schema.ts";
import type { MerchantIdentity, RoleSummary } from "./identity.ts";
import type { Permission } from "./permissions.ts";

/**
 * Sessions: minting one, resolving one, ending one.
 *
 * The token is 256 bits from the platform CSPRNG — not derived from the Merchant, not
 * sequential, and not guessable at any rate an attacker can sustain. What kobai stores is a
 * SHA-256 of it, so the table is not a list of credentials. SHA-256 rather than argon2 here
 * on purpose: the input already has full entropy, so there is nothing to brute-force and
 * nothing for a slow hash to buy, while a slow hash on the read path would tax every request.
 */

/**
 * How long a session lasts, from the moment it is issued. Absolute rather than sliding: an
 * unattended browser stops being an open door at a time that was fixed when the Merchant
 * signed in, rather than at a time their last click keeps pushing forward.
 */
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;

/** What a sign-in hands back. The token appears here and nowhere else, ever again. */
export type IssuedSession = {
  readonly token: string;
  readonly expiresAt: Date;
};

/** Who is making an admin request, and what they are allowed to do. */
export type Authenticated = {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly merchant: MerchantIdentity;
  readonly role: RoleSummary;
};

/**
 * Why an admin request is not authenticated.
 *
 * `expired` is distinct from `unknown` on purpose. An expired session means the Merchant was
 * signed in and now is not, and they are told so — the alternative, treating them as
 * anonymous, is the silent degradation ADR-0010's Admin would render as an empty page rather
 * than as a sign-in prompt.
 */
export type SessionRejection = "missing" | "malformed" | "unknown" | "expired";

export type SessionLookup =
  | { readonly ok: true; readonly auth: Authenticated }
  | { readonly ok: false; readonly reason: SessionRejection };

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issues a session for a Merchant, valid from now until {@link SESSION_LIFETIME_MS} hence.
 *
 * Signing in also clears that Merchant's sessions that have already run out. Housekeeping
 * rather than enforcement — {@link resolveSession} refuses an expired session whether or not
 * this has run — but it is what keeps the table from growing forever in a deployment whose
 * Merchants close the tab instead of signing out, without a sweeper nobody has asked for.
 */
export async function createSession(
  db: Database,
  merchantId: string,
): Promise<IssuedSession> {
  const now = new Date();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);

  await db
    .delete(session)
    .where(and(eq(session.merchantId, merchantId), lt(session.expiresAt, now)));

  await db
    .insert(session)
    .values({ merchantId, tokenHash: hashSessionToken(token), expiresAt });

  return { token, expiresAt };
}

/**
 * Resolves a token into the Merchant and Role behind it.
 *
 * An expired session is reported as expired every time it is presented, not once. The row is
 * deliberately **not** deleted here: deleting it would make the second request with the same
 * token look like a session that never existed, so an Admin firing several requests on page
 * load would be told "signed out" for one of them and "never signed in" for the rest. Being
 * told you have been signed out is the behaviour the ticket asks for, and it has to be the
 * answer every time. The row is cleared on the Merchant's next sign-in.
 */
export async function resolveSession(
  db: Database,
  token: string,
): Promise<SessionLookup> {
  const [row] = await db
    .select({
      sessionId: session.id,
      expiresAt: session.expiresAt,
      merchantId: merchant.id,
      email: merchant.email,
      roleName: role.name,
      permissions: role.permissions,
    })
    .from(session)
    .innerJoin(merchant, eq(merchant.id, session.merchantId))
    .innerJoin(role, eq(role.id, merchant.roleId))
    .where(eq(session.tokenHash, hashSessionToken(token)))
    .limit(1);

  if (!row) return { ok: false, reason: "unknown" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  return {
    ok: true,
    auth: {
      sessionId: row.sessionId,
      expiresAt: row.expiresAt,
      merchant: { id: row.merchantId, email: row.email },
      role: { name: row.roleName, permissions: row.permissions },
    },
  };
}

/** Ends a session. The row goes, so the token stops working on the very next request. */
export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(session).where(eq(session.id, sessionId));
}

export function holdsPermission(auth: Authenticated, permission: Permission): boolean {
  return auth.role.permissions.includes(permission);
}
