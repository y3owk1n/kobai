import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
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
      readonly reason: "invalid" | "email-taken" | "unknown-role";
      readonly detail: string;
    };

/**
 * What {@link createFirstMerchant} answers with: everything {@link createMerchant} can say,
 * plus the one refusal only the *first* Merchant can meet.
 *
 * Separate types rather than one widened union, because the extra reason is unreachable over
 * HTTP: `POST /admin/merchants` is guarded like every other admin route, so a caller has
 * already proved a Merchant exists by the time it runs. A shared union would make the route
 * declare a 409 for a conflict it can never meet.
 */
export type FirstMerchantCreation =
  | MerchantCreation
  | { readonly ok: false; readonly reason: "already-present"; readonly detail: string };

/**
 * The advisory-lock key creating the first Merchant serialises on.
 *
 * Arbitrary but fixed — any two connections asking for the same key take it in turn. It is
 * held for the length of the transaction and released when that ends, however it ends.
 */
const FIRST_MERCHANT_LOCK_KEY = 4_113_050_001;

/** One transaction, as the query builder hands it over. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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
 * Creates a Merchant against a named Role — what `POST /admin/merchants` does.
 *
 * It says nothing about who may do it: the route is guarded by `merchant:write` like every
 * other admin route, so by the time this runs the caller has already been let in. The *first*
 * Merchant on a deployment is {@link createFirstMerchant}, which is reached from boot rather
 * than from HTTP.
 */
export async function createMerchant(
  db: Database,
  input: CreateMerchantInput,
): Promise<MerchantCreation> {
  const usable = await usableCredentials(input);
  if (!usable.ok) return usable;

  return db.transaction((tx) => insertMerchant(tx, usable));
}

/**
 * Creates the **first** Merchant, and only while there is none.
 *
 * A deployment with no Merchant has nobody who could hold `merchant:write`, so the way in has
 * to come from outside the API: Core seeds it at boot from what the deployment was configured
 * with (see `./seed.ts`). This is the half that talks to the database, and the property it
 * holds is that it happens at most once — it takes an advisory lock and re-checks emptiness
 * *inside* the transaction, so two processes booting against one database cannot both win,
 * and a second boot finds a Merchant already there rather than creating another.
 */
export async function createFirstMerchant(
  db: Database,
  input: CreateMerchantInput,
): Promise<FirstMerchantCreation> {
  const usable = await usableCredentials(input);
  if (!usable.ok) return usable;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_MERCHANT_LOCK_KEY})`);
    const [existing] = await tx.select({ id: merchant.id }).from(merchant).limit(1);
    if (existing) {
      return {
        ok: false,
        reason: "already-present",
        detail:
          "This deployment already has a Merchant, so it was left exactly as it was found.",
      } as const;
    }

    return insertMerchant(tx, usable);
  });
}

/** Credentials that have been read and are worth hashing: the shape both paths insert from. */
type UsableCredentials = {
  readonly ok: true;
  readonly email: string;
  readonly passwordHash: string;
  readonly roleName: string;
};

/**
 * Narrows an unvalidated input and hashes its password — everything done *before* a
 * transaction opens.
 *
 * argon2 is slow by design, so hashing inside the transaction would hold the claim lock for
 * the length of it and let one caller stall every other.
 */
async function usableCredentials(
  input: CreateMerchantInput,
): Promise<UsableCredentials | Extract<MerchantCreation, { ok: false }>> {
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

  return {
    ok: true,
    email,
    passwordHash: await hashPassword(input.password),
    roleName: input.role ?? OWNER_ROLE,
  };
}

async function insertMerchant(
  tx: Transaction,
  { email, passwordHash, roleName }: UsableCredentials,
): Promise<MerchantCreation> {
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
    };
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
    };
  }

  return {
    ok: true,
    merchant: {
      id: created.id,
      email: created.email,
      role: { name: assigned.name, permissions: assigned.permissions },
    },
  };
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

/**
 * A page of Merchants, newest first, each with the Role they hold.
 *
 * The Role is joined rather than named by identifier, because *who has access* is the question
 * this list is asked and a client that had to fetch a Role per row would be asking it twice.
 * The digest is not selected here or anywhere: nothing outside {@link authenticateMerchant}
 * has any business reading it.
 */
export async function listMerchants(
  db: Database,
  page: PageRequest,
): Promise<Page<Merchant>> {
  const rows = await db
    .select({
      id: merchant.id,
      email: merchant.email,
      roleName: role.name,
      permissions: role.permissions,
      cursorAt: cursorAt(merchant.createdAt),
    })
    .from(merchant)
    .innerJoin(role, eq(role.id, merchant.roleId))
    .where(rowsAfter(page, merchant.createdAt, merchant.id))
    // `id` breaks the tie, so the cursor names one row rather than a group of them.
    .orderBy(desc(merchant.createdAt), desc(merchant.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  // Field by field rather than by spread, so neither the column the cursor is cut from nor
  // anything else this query adds later can reach a response by being forgotten about.
  return {
    items: found.map((row) => ({
      id: row.id,
      email: row.email,
      role: { name: row.roleName, permissions: row.permissions },
    })),
    nextCursor,
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
