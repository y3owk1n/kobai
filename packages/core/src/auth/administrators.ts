import { eq, ne, type SQL, sql } from "drizzle-orm";
import type { Transaction } from "../db/client.ts";
import { merchant, role } from "../db/schema.ts";
import { PERMISSIONS } from "./permissions.ts";

/**
 * The one invariant this surface will not let a Merchant break: **the deployment keeps at least
 * one Merchant able to administer Merchants** (ADR-0066).
 *
 * That is a lockout rather than a preference. A deployment holding nobody with
 * `merchant:write` has nobody who could put the Permission back and nobody who could sign a
 * colleague up to try — the first Merchant is seeded only while there is none (ADR-0041), so a
 * database with a Merchant already in it is never seeded again — and the way back is the raw
 * `UPDATE core_role` this whole surface exists to remove.
 *
 * **It is a module because two routes can reach it, and they must serialise on the same key.**
 * ADR-0066 said so before either of them existed: whoever added a route that moves or removes a
 * Merchant would inherit this invariant "in the harder form", counting the *Merchants* holding
 * the Permission rather than the Roles carrying it, and taking the same lock before its read.
 * `PATCH /admin/roles/{id}` narrows a Role and `PATCH /admin/merchants/{id}` moves a Merchant
 * off one, and either can be the last thing standing between a deployment and a lockout — so
 * *both* take {@link lockAdministrators}, and a second copy of that key in the second module is
 * exactly the drift that would let one of each run at once and both commit.
 *
 * **A conditional update cannot do this job**, which is the one place this surface departs from
 * ADR-0018's usual answer. Inventory claims a scarce thing with
 * `update … where on_hand - reserved >= n` because the condition is about *the row being
 * written*, so Postgres takes the row lock before evaluating it and the loser re-evaluates
 * against what the winner left. The lockout condition is about **other rows** — is there any
 * other Merchant, on any other Role, still holding `merchant:write` — and a subquery reads
 * those rows without locking them. So two requests each removing a different last administrator
 * would each see the other's and both commit, which is write skew and is precisely the state
 * these refusals exist to prevent.
 *
 * `packages/core/src/auth/the-last-administrator.test.ts` is the guardrail, it dispatches at
 * both routes, and each of its cases was watched failing with the lock taken out.
 */

/**
 * The advisory-lock key every change that could remove the last administrator serialises on.
 *
 * Arbitrary but fixed, exactly as `createFirstMerchant`'s is, and held for the length of the
 * transaction however that transaction ends. **There is one of it on purpose** — see the header.
 */
const ADMINISTRATOR_LOCK_KEY = 4_113_050_002;

/**
 * Takes the lock, and holds it to commit.
 *
 * Called **before** the read rather than around the write, so that the second request re-reads
 * a database the first has already changed. A caller that read first and locked afterwards
 * would have the lock and a stale answer, which is the bug wearing the fix's clothes.
 */
export async function lockAdministrators(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADMINISTRATOR_LOCK_KEY})`);
}

/** Whether a permission set carries the one Permission a lockout is measured in. */
export function administers(permissions: readonly string[]): boolean {
  return permissions.includes(PERMISSIONS.merchantWrite);
}

/**
 * Whether this Role is the only thing standing between the deployment and a lockout: some
 * Merchant holds it, and no Merchant holds any *other* Role carrying `merchant:write`.
 *
 * Both halves are needed. A Role nobody holds carries nobody's access, so narrowing it takes
 * nothing away; and a deployment that already has no administrator at all is not one this
 * refusal can repair, so it must not be one this refusal freezes.
 *
 * Only ever called with the lock held — a plain read of other rows locks nothing, which is the
 * whole reason that lock exists.
 */
export async function isTheLastAdministeringRole(
  tx: Transaction,
  id: string,
): Promise<boolean> {
  const [held] = await tx
    .select({ id: merchant.id })
    .from(merchant)
    .where(eq(merchant.roleId, id))
    .limit(1);
  if (!held) return false;

  return !(await someOtherAdministrator(tx, ne(role.id, id)));
}

/**
 * Whether this **Merchant** is the last one able to administer Merchants.
 *
 * ADR-0066's "harder form", and the difference from {@link isTheLastAdministeringRole} is the
 * whole of why it is a second function rather than the same one called differently: that one
 * asks whether any Merchant *outside this Role* administers, which is the right question when
 * the Role itself is being narrowed and every holder of it loses the Permission together. This
 * one asks whether any Merchant *other than this one* does — because moving one Merchant off an
 * administering Role leaves their colleagues on it exactly where they were, and asking by Role
 * would report a lockout for a deployment that has three administrators on one Role.
 *
 * It asks only the second half, with no "does anybody hold it" guard in front, because the
 * caller has already established that this Merchant administers: a Merchant whose Role does not
 * carry `merchant:write` cannot be the last one who does, so the question is never asked of
 * them. That is also what keeps ADR-0066's third clause true — a deployment with no
 * administrator at all is never refused, because no move can be found to remove the last one.
 *
 * Only ever called with the lock held, for {@link isTheLastAdministeringRole}'s reason.
 */
export async function isTheLastAdministrator(
  tx: Transaction,
  id: string,
): Promise<boolean> {
  return !(await someOtherAdministrator(tx, ne(merchant.id, id)));
}

/**
 * Whether any Merchant the caller has excluded still holds `merchant:write` through their Role.
 *
 * The exclusion is passed in as the comparison rather than as an identifier and a flag, because
 * the two callers exclude on **different tables** — one every holder of a Role, the other one
 * named Merchant — and a boolean argument deciding which would be the kind of parameter a
 * reader has to hold in their head at the call site.
 *
 * `@>` is Postgres's array containment, which is the same test `permissions.includes(…)` makes
 * in TypeScript, asked of the column so the database can answer it in one statement.
 */
async function someOtherAdministrator(tx: Transaction, outside: SQL): Promise<boolean> {
  const [found] = await tx
    .select({ id: merchant.id })
    .from(merchant)
    .innerJoin(role, eq(role.id, merchant.roleId))
    .where(
      sql`${outside} and ${role.permissions} @> array[${PERMISSIONS.merchantWrite}]::text[]`,
    )
    .limit(1);

  return found !== undefined;
}
