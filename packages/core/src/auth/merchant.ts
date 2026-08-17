import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { merchant, role } from "../db/schema.ts";
import {
  digestOfNoMerchant,
  hashPassword,
  MINIMUM_PASSWORD_LENGTH,
  verifyPassword,
} from "./credentials.ts";
import type { MerchantIdentity, RoleSummary } from "./identity.ts";
import { OWNER_ROLE } from "./permissions.ts";

/**
 * Merchant accounts: creating one, and proving you are one.
 *
 * A Merchant is the only kind of account Core has. There is no Shopper here and there is not
 * going to be one — Core stores no Shopper credential (ADR-0020), so this module is
 * deliberately named for the one audience it serves rather than for "users" in general.
 */

/**
 * A Merchant as the API reports it — never the digest, and never a Store, because a Merchant
 * belongs to the deployment and the deployment is one Store (ADR-0005).
 */
export type Merchant = MerchantIdentity & { readonly role: RoleSummary };

export type MerchantCreation =
  | { readonly ok: true; readonly merchant: Merchant }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "email-taken" | "unknown-role" | "already-claimed";
      readonly detail: string;
    };

/**
 * The advisory-lock key the bootstrap path serialises on.
 *
 * Arbitrary but fixed — any two connections asking for the same key take it in turn. It is
 * held for the length of the transaction and released when that ends, however it ends.
 */
const BOOTSTRAP_LOCK_KEY = 4_113_050_001;

/**
 * Unvalidated, because it arrives as a JSON body. Everything below narrows it before it
 * reaches the database, so the validation lives in one place rather than at the edge and
 * again here.
 */
export type CreateMerchantInput = {
  readonly email?: unknown;
  readonly password?: unknown;
  readonly role?: unknown;
};

/**
 * Creates a Merchant against a named Role.
 *
 * `bootstrap` additionally requires that the deployment holds no Merchant at all. That path
 * exists because a brand new deployment has nobody who could hold `merchant:write`, so
 * requiring the permission unconditionally would leave the Admin permanently unreachable.
 * It runs under an advisory lock and re-checks emptiness inside the transaction, so two
 * requests racing to claim a fresh deployment cannot both win.
 */
export async function createMerchant(
  db: Database,
  input: CreateMerchantInput,
  options: { readonly bootstrap: boolean },
): Promise<MerchantCreation> {
  const email = normaliseEmail(input.email);
  if (!email) {
    return { ok: false, reason: "invalid", detail: "`email` must be an email address." };
  }
  if (
    typeof input.password !== "string" ||
    input.password.length < MINIMUM_PASSWORD_LENGTH
  ) {
    return {
      ok: false,
      reason: "invalid",
      detail: `\`password\` must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
    };
  }
  if (input.role !== undefined && typeof input.role !== "string") {
    return { ok: false, reason: "invalid", detail: "`role` must be the name of a Role." };
  }

  // Outside the transaction: argon2 is slow by design, and holding the bootstrap lock while
  // it runs would let one request stall every other.
  const passwordHash = await hashPassword(input.password);
  const roleName = input.role ?? OWNER_ROLE;

  return db.transaction(async (tx) => {
    if (options.bootstrap) {
      await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
      const [existing] = await tx.select({ id: merchant.id }).from(merchant).limit(1);
      if (existing) {
        return {
          ok: false,
          reason: "already-claimed",
          detail:
            "This deployment already has a Merchant. Sign in and create further Merchants with a session.",
        } as const;
      }
    }

    const [assigned] = await tx
      .select({ id: role.id, name: role.name, permissions: role.permissions })
      .from(role)
      .where(eq(role.name, roleName))
      .limit(1);
    if (!assigned) {
      return {
        ok: false,
        reason: "unknown-role",
        detail: `No Role named ${JSON.stringify(roleName)} exists.`,
      } as const;
    }

    // No select-then-insert: two requests offering the same address would both find nothing
    // and the loser's insert would surface as a 500 rather than as the conflict it is. The
    // unique index is the check, and `on conflict` is how its answer is read.
    const [created] = await tx
      .insert(merchant)
      .values({ email, passwordHash, roleId: assigned.id })
      .onConflictDoNothing({ target: merchant.email })
      .returning({ id: merchant.id, email: merchant.email });

    if (!created) {
      return {
        ok: false,
        reason: "email-taken",
        detail: "A Merchant with that email address already exists.",
      } as const;
    }

    return {
      ok: true,
      merchant: {
        id: created.id,
        email: created.email,
        role: { name: assigned.name, permissions: assigned.permissions },
      },
    } as const;
  });
}

/**
 * Checks a Merchant's credentials.
 *
 * An unknown address and a wrong password are indistinguishable, in the answer and in the
 * time taken: an unknown address is still verified, against a digest of a password nobody
 * has. Otherwise the sign-in endpoint would answer "is this person a Merchant here" to
 * anyone willing to time it.
 */
export async function authenticateMerchant(
  db: Database,
  email: unknown,
  password: unknown,
): Promise<Merchant | undefined> {
  const normalised = normaliseEmail(email);
  if (!normalised || typeof password !== "string") {
    await verifyPassword(await digestOfNoMerchant(), "");
    return undefined;
  }

  const [row] = await db
    .select({
      id: merchant.id,
      email: merchant.email,
      passwordHash: merchant.passwordHash,
      roleName: role.name,
      permissions: role.permissions,
    })
    .from(merchant)
    .innerJoin(role, eq(role.id, merchant.roleId))
    .where(eq(merchant.email, normalised))
    .limit(1);

  const digest = row?.passwordHash ?? (await digestOfNoMerchant());
  const correct = await verifyPassword(digest, password);
  if (!correct || !row) return undefined;

  return {
    id: row.id,
    email: row.email,
    role: { name: row.roleName, permissions: row.permissions },
  };
}

/** Whether this deployment has been claimed by anybody yet. */
export async function hasAnyMerchant(db: Database): Promise<boolean> {
  const [row] = await db.select({ id: merchant.id }).from(merchant).limit(1);
  return row !== undefined;
}

/**
 * Lowercased and trimmed, or `undefined` when it is not an email address at all.
 *
 * Deliberately permissive: the exhaustive regex is a well-known way to reject valid
 * addresses, and Core is not the thing that proves an address reaches anybody.
 */
function normaliseEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return undefined;
  return trimmed;
}
