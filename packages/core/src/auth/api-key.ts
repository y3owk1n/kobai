import { createHash, randomBytes } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { joined } from "../db/join.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
import { apiKey, channel } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import {
  type CHANNEL_NOT_FOUND,
  type ChannelIdentity,
  unknownChannel,
} from "../store/channel.ts";

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

/**
 * A key, as it is reported once and never again.
 *
 * `id` is here because it is the only handle that survives this response: a Merchant who
 * wants to revoke this key later needs it, and the key itself will be gone.
 */
export type IssuedApiKey = {
  readonly id: string;
  readonly name: string;
  readonly kind: ApiKeyKind;
  /**
   * Which Channel a request presenting this key is in, or `null` for unconstrained (#291).
   *
   * Reported because a key's Channel is fixed at minting and this response is the one place a
   * Merchant is told what they minted. Since #292 it is also what decides the Price every
   * request presenting this key resolves against.
   */
  readonly channelId: string | null;
  readonly createdAt: string;
  /** The value itself. Shown at creation and unrecoverable afterwards. */
  readonly key: string;
};

/**
 * A key as the Admin lists it: enough to recognise and revoke, never enough to present.
 *
 * There is deliberately no fragment of the value here — not a prefix beyond the kind, not
 * the last four characters. Only a SHA-256 of the whole key is stored, so there is nothing
 * to show; and a listing that showed *some* of a key would be a second place a credential
 * partly lives, bought for a convenience `name` already provides.
 *
 * `revokedAt` rather than a boolean, and a revoked key stays in the list: "there is no such
 * key" and "that key stopped working on Tuesday" are different answers to the same question.
 */
export type ApiKeySummary = {
  readonly id: string;
  readonly name: string;
  readonly kind: ApiKeyKind;
  /** Which Channel a request presenting it is in, or `null` for unconstrained (#291). */
  readonly channelId: string | null;
  readonly createdAt: string;
  /** When it stopped working, or `null` while it still does. */
  readonly revokedAt: string | null;
};

/** Unvalidated: it arrives as a JSON body and is narrowed in one place, below. */
export type CreateApiKeyInput = {
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly channelId?: unknown;
};

/**
 * Minting a key refuses two ways, and the second is a fact about the Store rather than the body.
 *
 * `channel-not-found` is the same word `GET /admin/channels/{id}` answers 404 with, at **422**
 * here on `collection-not-found`'s distinction: the body is well formed — an identifier in the
 * right place — and what refuses it is a Channel this Store has not got. One fact gets one word
 * (ADR-0060).
 */
export type ApiKeyCreation =
  | { readonly ok: true; readonly apiKey: IssuedApiKey }
  | {
      readonly ok: false;
      readonly reason: "invalid" | typeof CHANNEL_NOT_FOUND;
      readonly detail: string;
    };

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
  /**
   * The Channel every request presenting this key is in, or `null` for a key in no particular
   * one (#292, ADR-0005, ADR-0020).
   *
   * **This is the whole of how a request's Channel is decided**, which is what spares a
   * storefront threading one through every call and stops it claiming to be in a Channel it was
   * not issued a credential for. `resolve-price` is what reads it: a Price constrained to a
   * Channel applies to the keys bound to it and to no others.
   *
   * The Channel rather than its identifier, because the name travels out to the storefront on
   * the answer — `ResolvedPrice.channel` — and a second request to find out what one's own key
   * is called would be one every client made.
   */
  readonly channel: ChannelIdentity | null;
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

  // **Which Channel this key is in is decided here and never again** (ADR-0005, ADR-0020). A
  // storefront presenting it therefore cannot claim to be in a Channel it was not issued a
  // credential for, and does not have to thread one through every request. Absent is `null`,
  // which is unconstrained — what every key that exists today is, and what a deployment that has
  // defined no Channel can say.
  let channelId: string | null = null;
  if (input.channelId !== undefined && input.channelId !== null) {
    if (typeof input.channelId !== "string" || !isUuid(input.channelId)) {
      return {
        ok: false,
        reason: "invalid",
        detail:
          "`channelId` must be the `id` of a Channel this Store has — `GET /admin/channels` lists them. Leave it out for a key that is in no particular Channel.",
      };
    }

    // Asked rather than left to the foreign key, so the refusal can name the Channel and say
    // where to find the ones this Store does have. One deleted in the window between the two
    // travels as the 500 it is, which is `collectionsThisStoreDoesNotHave`'s bargain.
    const missing = await unknownChannel(db, input.channelId);
    if (missing) return missing;
    channelId = input.channelId;
  }

  const key = `${API_KEY_PREFIX[kind]}${randomBytes(KEY_BYTES).toString("base64url")}`;

  const [created] = await db
    .insert(apiKey)
    .values({ name, kind, channelId, tokenHash: hashApiKey(key) })
    .returning({
      id: apiKey.id,
      name: apiKey.name,
      channelId: apiKey.channelId,
      createdAt: apiKey.createdAt,
    });
  if (!created) throw new Error("Inserting an API key returned no row.");

  return {
    ok: true,
    apiKey: {
      id: created.id,
      name: created.name,
      kind,
      channelId: created.channelId,
      createdAt: created.createdAt.toISOString(),
      key,
    },
  };
}

/**
 * A page of the keys this deployment has issued, newest first — revoked ones included.
 *
 * One Store per deployment (ADR-0005), so there is nothing to scope by and no filter to
 * take. Paged like every other list on this surface (ADR-0064): this is the shortest of the
 * three and pages anyway, because a surface where some lists page and others do not is one a
 * client has to learn twice.
 */
export async function listApiKeys(
  db: Database,
  page: PageRequest,
): Promise<Page<ApiKeySummary>> {
  const fetched = await db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      kind: apiKey.kind,
      channelId: apiKey.channelId,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt,
      cursorAt: cursorAt(apiKey.createdAt),
    })
    .from(apiKey)
    .where(rowsAfter(page, apiKey.createdAt, apiKey.id))
    // `id` breaks the tie, so two keys minted in the same millisecond still list in a
    // stable order rather than whichever one Postgres reached first — and so that a cursor
    // cut from the last of them names one row rather than a group of them.
    .orderBy(desc(apiKey.createdAt), desc(apiKey.id))
    .limit(pageSize(page));

  const { rows, nextCursor } = takePage(fetched, page);

  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: asKind(row.kind),
      channelId: row.channelId,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    })),
    nextCursor,
  };
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
      // A `left` join, because a key in no particular Channel is the ordinary key and an inner
      // one would answer `unknown` for it — a live credential reported as one nobody issued.
      channel: { id: channel.id, name: channel.name },
    })
    .from(apiKey)
    .leftJoin(channel, eq(channel.id, apiKey.channelId))
    .where(eq(apiKey.tokenHash, hashApiKey(presented)))
    .limit(1);

  if (!row) return { ok: false, reason: "unknown" };
  if (row.revokedAt !== null) return { ok: false, reason: "revoked" };

  return {
    ok: true,
    apiKey: {
      id: row.id,
      name: row.name,
      kind: asKind(row.kind),
      // `db/join.ts` is the reading of a left join, and why it is not `row.channel ?? null`.
      channel: joined<ChannelIdentity>(row.channel),
    },
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
