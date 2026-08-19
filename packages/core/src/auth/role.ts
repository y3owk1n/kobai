import { desc, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { violatesForeignKey, violatesUniqueIndex } from "../db/errors.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
import { merchant, role } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { trimmed } from "../input.ts";
import {
  type Changes,
  changesFrom,
  changesNothing,
  mustBeText,
  openData,
  text,
} from "../patch.ts";
import { PERMISSIONS } from "./permissions.ts";

/**
 * Roles: creating one, reading them, changing what one may do, and removing one.
 *
 * A Role is a name and a **set of Permission strings** (ADR-0027), and this module is what
 * finally makes that reachable — until #173 exactly one Role existed, seeded by a migration,
 * and a narrower one could only be written with SQL.
 *
 * Two rules live here rather than in a schema, and each is a decision ADR-0066 records:
 *
 * - **A Permission this build of Core has never heard of is preserved, not rejected.** The
 *   `Session` schema promises exactly that in as many words, so checking a Role's permissions
 *   against {@link PERMISSIONS} would make the description false and would foreclose a
 *   Plugin-supplied Permission before anybody has designed one. What is checked is that each
 *   is a non-empty string, which is a shape rather than a vocabulary.
 * - **The deployment keeps at least one Merchant able to administer Merchants.** That is a
 *   lockout rather than a preference: a deployment with nobody holding `merchant:write` has
 *   no way back in short of the SQL this whole surface exists to remove.
 */

/** A Role as the admin surface reports it — the whole row, minus the columns nobody reads. */
export type Role = {
  readonly id: string;
  readonly name: string;
  /**
   * `readonly string[]` and never `Permission[]`, for {@link RoleSummary}'s reason: a
   * deployment may hold a Permission this build of Core has never heard of.
   */
  readonly permissions: readonly string[];
  readonly metadata: Record<string, unknown>;
};

export type RoleCreation =
  | { readonly ok: true; readonly role: Role }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "role-name-taken";
      readonly detail: string;
    };

/**
 * Changing a Role refuses in four ways, and only the last is about the deployment as a whole.
 *
 * `last-administrator` is the lockout guard: it is reached when a change would leave no
 * Merchant holding `merchant:write`, and it is the only refusal here that is about rows this
 * request never named.
 */
export type RoleUpdate =
  | { readonly ok: true; readonly role: Role }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid"
        | "role-not-found"
        | "role-name-taken"
        | "last-administrator";
      readonly detail: string;
    };

/**
 * Deleting a Role refuses rather than cascading or reassigning, which is ADR-0059's shape
 * applied to the one table that points at this one.
 */
export type RoleDeletion =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "role-not-found" | "role-in-use";
      readonly detail: string;
    };

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type CreateRoleInput = {
  readonly name?: unknown;
  readonly permissions?: unknown;
  readonly metadata?: unknown;
};

export type UpdateRoleInput = CreateRoleInput;

/**
 * The advisory-lock key every change that could remove the last administrator serialises on.
 *
 * Arbitrary but fixed, exactly as `createFirstMerchant`'s is, and held for the length of the
 * transaction however that transaction ends.
 *
 * **A conditional update cannot do this job**, which is the one place this surface departs
 * from ADR-0018's usual answer. Inventory claims a scarce thing with
 * `update … where on_hand - reserved >= n` because the condition is about *the row being
 * written*, so Postgres takes the row lock before evaluating it and the loser re-evaluates
 * against what the winner left. The lockout condition is about **other rows** — is there any
 * other Merchant, on any other Role, still holding `merchant:write` — and a subquery reads
 * those rows without locking them. So two requests each stripping a different last
 * administrator would each see the other's Role and both commit, which is write skew and is
 * precisely the state this refusal exists to prevent. The lock is taken *before* the read, so
 * the second request re-reads a database the first has already changed.
 */
const ADMINISTRATOR_LOCK_KEY = 4_113_050_002;

/**
 * The unique constraint on a Role's name, as `0002` created it — a `UNIQUE` constraint rather
 * than a bare index, which is what `.unique()` on the column generates and what Postgres names
 * in the error either way.
 */
const ROLE_NAME_UNIQUE = "core_role_name_unique";

/** The foreign key a Merchant's Role reference is held by, as `0002` created it. */
const MERCHANT_ROLE_FOREIGN_KEY = "core_merchant_role_id_core_role_id_fk";

/**
 * Said once, because two paths reach it: creating a Role with no `name` at all, and either path
 * given one that is blank. A caller sees the same sentence for the same mistake.
 *
 * From `patch.ts` since #185, so that "the same mistake" now spans every field on the surface
 * that has to be a non-empty string and not only this one — {@link text} is where the blank
 * half is said, and this is the absent half, which no narrowing is ever asked about.
 */
const NAME_MUST_BE_A_NAME = mustBeText("name");

/** The columns a Role is reported by. Named once, because five queries answer with them. */
const REPORTED = {
  id: role.id,
  name: role.name,
  permissions: role.permissions,
  metadata: role.metadata,
} as const;

export async function createRole(
  db: Database,
  input: CreateRoleInput,
): Promise<RoleCreation> {
  const usable = readRoleInput(input);
  if (!usable.ok) return usable;

  const { name, permissions = [], metadata = {} } = usable.changes;
  if (name === undefined) {
    return { ok: false, reason: "invalid", detail: NAME_MUST_BE_A_NAME };
  }

  // No select-then-insert: two requests offering the same name would both find nothing and
  // the loser's insert would surface as a 500 rather than as the conflict it is. The unique
  // index is the check, and `on conflict` is how its answer is read.
  const [created] = await db
    .insert(role)
    .values({ name, permissions, metadata })
    .onConflictDoNothing({ target: role.name })
    .returning(REPORTED);

  if (!created) return nameTaken(name);
  return { ok: true, role: created };
}

/**
 * A page of Roles, newest first — the same ordering and the same cursor every other list on
 * this surface uses (ADR-0064), ending in `id` so it cannot tie.
 */
export async function listRoles(db: Database, page: PageRequest): Promise<Page<Role>> {
  const rows = await db
    .select({ ...REPORTED, cursorAt: cursorAt(role.createdAt) })
    .from(role)
    .where(rowsAfter(page, role.createdAt, role.id))
    .orderBy(desc(role.createdAt), desc(role.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  // Field by field rather than by spread, so the column the cursor is cut from cannot reach a
  // response by being forgotten about.
  return {
    items: found.map((row) => ({
      id: row.id,
      name: row.name,
      permissions: row.permissions,
      metadata: row.metadata,
    })),
    nextCursor,
  };
}

/**
 * One Role, or `undefined` when there is no such Role — including when `id` is not an
 * identifier at all, which is the same answer to the caller.
 */
export async function readRole(db: Database, id: string): Promise<Role | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db.select(REPORTED).from(role).where(eq(role.id, id)).limit(1);
  return row;
}

/**
 * Changes a Role — its name, what it may do, and its metadata.
 *
 * The same `PATCH` every other correction on this surface is: an absent field means "leave
 * it", a named `metadata` **replaces** what is stored rather than merging into it, and a body
 * naming nothing is refused rather than answered 200 with the row unchanged.
 *
 * **A named `permissions` replaces the whole set**, because a set is what it is. There is no
 * add-one and no remove-one, which would be two more routes saying what this one says and
 * would each need their own answer to the lockout question below.
 */
export async function updateRole(
  db: Database,
  id: string,
  input: UpdateRoleInput,
): Promise<RoleUpdate> {
  const usable = readRoleInput(input);
  if (!usable.ok) return usable;

  const changes = usable.changes;
  // Asked here rather than inside `readRoleInput`, which `createRole` shares: there an empty
  // result is a missing `name` rather than a no-op, and it is answered as one.
  if (Object.keys(changes).length === 0) {
    return changesNothing("a `name`, a `permissions`, a `metadata`, or any of them");
  }

  if (!isUuid(id)) return notFound(id);

  // Only a body naming `permissions` can reach the lockout, so only that body takes the lock —
  // a rename or a metadata edit is left to run beside every other one rather than queueing
  // behind them deployment-wide for an invariant it cannot touch.
  const asked = changes.permissions;

  return db.transaction(async (tx) => {
    // Before the read, and for the length of the transaction: see ADMINISTRATOR_LOCK_KEY.
    if (asked !== undefined) {
      await tx.execute(sql`select pg_advisory_xact_lock(${ADMINISTRATOR_LOCK_KEY})`);
    }

    const [current] = await tx
      .select({ id: role.id, permissions: role.permissions })
      .from(role)
      .where(eq(role.id, id))
      .limit(1);
    if (!current) return notFound(id);

    if (
      asked !== undefined &&
      administers(current.permissions) &&
      !administers(asked) &&
      (await isTheLastAdministeringRole(tx, id))
    ) {
      return {
        ok: false,
        reason: "last-administrator",
        detail: `Every Merchant able to administer Merchants holds this Role, so taking ${PERMISSIONS.merchantWrite} off it would leave this deployment with nobody who could put it back — including nobody who could sign a colleague up to try. Give another Role ${PERMISSIONS.merchantWrite}, and a Merchant that Role, before narrowing this one.`,
      } as const;
    }

    try {
      const [updated] = await tx
        .update(role)
        .set(changes)
        .where(eq(role.id, id))
        .returning(REPORTED);
      if (!updated) return notFound(id);
      return { ok: true, role: updated } as const;
    } catch (cause) {
      // The constraint is the check here too, and it is read from the other side because an
      // `update` has no `on conflict` to hang the answer off. Same guarantee either way: the
      // database decides, rather than a read that was true a moment before the write.
      if (changes.name !== undefined && violatesUniqueIndex(cause, ROLE_NAME_UNIQUE)) {
        return nameTaken(changes.name);
      }
      throw cause;
    }
  });
}

/**
 * Deletes a Role, and **refuses while any Merchant holds it** (ADR-0066).
 *
 * Refusing rather than cascading or reassigning, which is ADR-0059's argument arriving at a
 * different table: deleting the Merchants would remove people to tidy up a label, and moving
 * them to some other Role would be Core choosing who a colleague becomes. Both are worse than
 * being told to reassign them first, and only being told is reversible.
 *
 * **One statement, and the refusal is read off Postgres rather than asked for first.** A
 * `select` for Merchants followed by a `delete` would let `POST /admin/merchants` slip a new
 * Merchant onto the Role in between, and the foreign key would then answer what this function
 * had already promised was safe — as a 500, for what is an ordinary conflict.
 */
export async function deleteRole(db: Database, id: string): Promise<RoleDeletion> {
  if (!isUuid(id)) return notFound(id);

  try {
    const [deleted] = await db
      .delete(role)
      .where(eq(role.id, id))
      .returning({ id: role.id });
    if (!deleted) return notFound(id);
    return { ok: true };
  } catch (cause) {
    if (violatesForeignKey(cause, MERCHANT_ROLE_FOREIGN_KEY)) {
      return {
        ok: false,
        reason: "role-in-use",
        detail:
          "Merchants hold this Role, and deleting it would leave them signed in holding nothing at all. Move them to another Role first — `GET /admin/merchants` says who they are.",
      };
    }
    throw cause;
  }
}

/**
 * Whether this Role is the only thing standing between the deployment and a lockout: some
 * Merchant holds it, and no Merchant holds any *other* Role carrying `merchant:write`.
 *
 * Both halves are needed. A Role nobody holds carries nobody's access, so narrowing it takes
 * nothing away; and a deployment that already has no administrator at all is not one this
 * refusal can repair, so it must not be one this refusal freezes.
 *
 * Only ever called with {@link ADMINISTRATOR_LOCK_KEY} held — a plain read of other rows locks
 * nothing, which is the whole reason that lock exists.
 */
async function isTheLastAdministeringRole(tx: Transaction, id: string): Promise<boolean> {
  const [held] = await tx
    .select({ id: merchant.id })
    .from(merchant)
    .where(eq(merchant.roleId, id))
    .limit(1);
  if (!held) return false;

  const [elsewhere] = await tx
    .select({ id: merchant.id })
    .from(merchant)
    .innerJoin(role, eq(role.id, merchant.roleId))
    .where(
      sql`${ne(role.id, id)} and ${role.permissions} @> array[${PERMISSIONS.merchantWrite}]::text[]`,
    )
    .limit(1);

  return elsewhere === undefined;
}

/** One transaction, as the query builder hands it over. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Whether a permission set carries the one Permission a lockout is measured in. */
function administers(permissions: readonly string[]): boolean {
  return permissions.includes(PERMISSIONS.merchantWrite);
}

/**
 * The columns a body names, narrowed — the one place a Role's input is read, so that creating
 * one and correcting one cannot disagree about what a Permission looks like.
 *
 * An absent key is absent from the result, which is what makes the caller's "leave it alone"
 * and this module's `set` the same object.
 */
function readRoleInput(input: CreateRoleInput): Changes<RoleColumns> {
  return changesFrom(
    {
      name: input.name,
      permissions: input.permissions,
      metadata: input.metadata,
    },
    {
      name: text("name"),
      permissions: (value) => {
        const permissions = readPermissions(value);
        return permissions === undefined
          ? {
              ok: false,
              reason: "invalid",
              detail:
                "`permissions` must be an array of non-empty strings. Which strings is not checked: a Role may hold a Permission this build of Core has never heard of, because a Plugin's is a string like any other.",
            }
          : { ok: true, value: permissions };
      },
      metadata: openData("metadata"),
    },
  );
}

/** The columns a body names, of which it names some. */
type RoleColumns = {
  name: string;
  permissions: string[];
  metadata: Record<string, unknown>;
};

/**
 * A permission set as it is written down: non-empty strings, trimmed, each kept once.
 *
 * **Nothing is checked against {@link PERMISSIONS}, deliberately.** A Role carrying a word this
 * build has never heard of is preserved, because the Session schema promises so and because a
 * Plugin's Permission has to be possible later without Core having enumerated it (ADR-0066).
 *
 * Deduplicated because it is a *set*: the same word twice is the same grant twice, and the
 * order is otherwise the caller's and is kept.
 */
function readPermissions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const permissions: string[] = [];
  for (const entry of value) {
    const permission = trimmed(entry);
    if (permission === undefined) return undefined;
    if (!permissions.includes(permission)) permissions.push(permission);
  }
  return permissions;
}

function nameTaken(name: string): {
  ok: false;
  reason: "role-name-taken";
  detail: string;
} {
  return {
    ok: false,
    reason: "role-name-taken",
    detail: `A Role named ${JSON.stringify(name)} already exists. A Role's name is how a Merchant is created against it, so two of them could not be told apart.`,
  };
}

function notFound(id: string): { ok: false; reason: "role-not-found"; detail: string } {
  return {
    ok: false,
    reason: "role-not-found",
    detail: `No Role with the identifier ${JSON.stringify(id)} exists.`,
  };
}
