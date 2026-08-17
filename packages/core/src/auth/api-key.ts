import { createHash, randomBytes } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { apiKey } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";

/**
 * API keys: minting one, resolving one, revoking one.
 *
 * Core owns these, as it owns Merchant auth, and it owns no Shopper credential at all
 * (ADR-0020). A key authenticates a *deployment* — a storefront, a server — and never a
 * person, which is why nothing here carries a Role.
 *
 * Two properties are the whole module:
 *
 * - **The kind is visible in the value.** `kobai_pk_…` is publishable, `kobai_sk_…` is
 *   secret, and telling them apart needs no lookup and no documentation. Spec story 45 asks
 *   for this so that shipping a secret to a browser is a mistake a Developer can *see*,
 *   including in a code review, a log line and a bug report.
 * - **Only a digest is stored.** SHA-256 rather than argon2, for the same reason sessions
 *   use it: the input is 256 bits from the platform CSPRNG, so there is no low-entropy
 *   secret to brute-force and a slow hash would buy nothing while taxing every store-surface
 *   request. A password is different in kind — a person chose it — and keeps argon2id.
 */

/** What a key may be. The list is closed, and the database says so too. */
export const API_KEY_KINDS = ["publishable", "secret"] as const;

export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

/**
 * What each kind of key looks like.
 *
 * `kobai_` first so the vendor is identifiable in a leaked string — which is what lets
 * secret scanners recognise one — then `pk`/`sk`, following the convention a Developer will
 * already know from Stripe rather than inventing a private one.
 */
export const API_KEY_PREFIX = {
  publishable: "kobai_pk_",
  secret: "kobai_sk_",
} as const satisfies Record<ApiKeyKind, string>;

/** 256 bits, like a session token, and for the same reason. */
const KEY_BYTES = 32;

/** A key, as it is reported once and never again. */
export type IssuedApiKey = ApiKeySummary & {
  /** The value itself. Shown at creation and unrecoverable afterwards. */
  readonly key: string;
};

/** A key as the Admin lists it: enough to recognise and revoke, never enough to present. */
export type ApiKeySummary = {
  readonly id: string;
  readonly name: string;
  readonly kind: ApiKeyKind;
  readonly createdAt: string;
  readonly revokedAt: string | null;
};

/** Unvalidated: it arrives as a JSON body and is narrowed in one place, below. */
export type CreateApiKeyInput = {
  readonly name?: unknown;
  readonly kind?: unknown;
};

export type ApiKeyCreation =
  | { readonly ok: true; readonly apiKey: IssuedApiKey }
  | { readonly ok: false; readonly reason: "invalid"; readonly detail: string };

/**
 * Why a store-surface request is not authenticated.
 *
 * `revoked` is distinct from `unknown` because a Developer whose key stopped working needs
 * to know whether they revoked it or mistyped it, and those have different fixes.
 */
export type ApiKeyRejection = "missing" | "malformed" | "unknown" | "revoked";

/** Who is making a store-surface request. No Merchant, and no Role — see ADR-0020. */
export type AuthenticatedApiKey = {
  readonly id: string;
  readonly name: string;
  readonly kind: ApiKeyKind;
};

export type ApiKeyLookup =
  | { readonly ok: true; readonly apiKey: AuthenticatedApiKey }
  | { readonly ok: false; readonly reason: ApiKeyRejection };

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Mints a key of the given kind. The value returned here is the only copy that exists. */
export async function createApiKey(
  db: Database,
  input: CreateApiKeyInput,
): Promise<ApiKeyCreation> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "") {
    return {
      ok: false,
      reason: "invalid",
      detail:
        "`name` must be a non-empty string. It is how a Merchant tells one key from another when revoking.",
    };
  }

  const kind = API_KEY_KINDS.find((known) => known === input.kind);
  if (!kind) {
    return {
      ok: false,
      reason: "invalid",
      detail: `\`kind\` must be one of ${API_KEY_KINDS.join(", ")}. A publishable key is safe in a browser; a secret key is not.`,
    };
  }

  const key = `${API_KEY_PREFIX[kind]}${randomBytes(KEY_BYTES).toString("base64url")}`;

  const [created] = await db
    .insert(apiKey)
    .values({ name, kind, tokenHash: hashApiKey(key) })
    .returning({
      id: apiKey.id,
      name: apiKey.name,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt,
    });
  if (!created) throw new Error("Inserting an API key returned no row.");

  return { ok: true, apiKey: { ...summary({ ...created, kind }), key } };
}

/** Every key, newest first. Names them; carries none of them. */
export async function listApiKeys(db: Database): Promise<ApiKeySummary[]> {
  const rows = await db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      kind: apiKey.kind,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt,
    })
    .from(apiKey)
    .orderBy(desc(apiKey.createdAt), desc(apiKey.id));

  return rows.map((row) => summary({ ...row, kind: asKind(row.kind) }));
}

/**
 * Revokes a key, and says whether there was one to revoke.
 *
 * Revoking an already-revoked key leaves the first revocation's timestamp alone — the useful
 * fact is when it stopped working, and a second request should not move it.
 */
export async function revokeApiKey(db: Database, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;

  const revoked = await db
    .update(apiKey)
    // `coalesce` rather than `now()`: revoking twice is idempotent, and the useful fact is
    // *when the key stopped working*, which a second request should not move.
    .set({ revokedAt: sql`coalesce(${apiKey.revokedAt}, now())` })
    .where(eq(apiKey.id, id))
    .returning({ id: apiKey.id });

  return revoked.length > 0;
}

/**
 * Resolves a presented key into the key behind it.
 *
 * The prefix is checked before the database is, so a Merchant session token — or anything
 * else that is simply not a kobai API key — is answered `malformed` rather than being looked
 * up and reported as `unknown`. The two mean different things to whoever is debugging.
 */
export async function resolveApiKey(
  db: Database,
  presented: string,
): Promise<ApiKeyLookup> {
  const carries = API_KEY_KINDS.some((kind) =>
    presented.startsWith(API_KEY_PREFIX[kind]),
  );
  if (!carries) return { ok: false, reason: "malformed" };

  const [row] = await db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      kind: apiKey.kind,
      revokedAt: apiKey.revokedAt,
    })
    .from(apiKey)
    .where(eq(apiKey.tokenHash, hashApiKey(presented)))
    .limit(1);

  if (!row) return { ok: false, reason: "unknown" };
  if (row.revokedAt !== null) return { ok: false, reason: "revoked" };

  return {
    ok: true,
    apiKey: { id: row.id, name: row.name, kind: asKind(row.kind) },
  };
}

function summary(row: {
  id: string;
  name: string;
  kind: ApiKeyKind;
  createdAt: Date;
  revokedAt: Date | null;
}): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * The `kind` column as the closed set it is.
 *
 * A check constraint makes anything else unwritable, so this cannot fail for a row Core
 * wrote. It throws rather than defaulting because a row that got past the constraint means
 * the schema is not what this code believes, and quietly treating it as publishable would be
 * the worst available guess.
 */
function asKind(value: string): ApiKeyKind {
  const kind = API_KEY_KINDS.find((known) => known === value);
  if (!kind) {
    throw new Error(
      `An API key row holds the kind ${JSON.stringify(value)}, which is neither ${API_KEY_KINDS.join(" nor ")}.`,
    );
  }
  return kind;
}
