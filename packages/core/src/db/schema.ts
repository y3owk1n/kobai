import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Core's tables. Every one of them is prefixed `core_`, which is what this package's
 * `tablesFilter` is scoped to.
 *
 * Core's schema shape is explicitly **not** part of the stability promise (ADR-0003). A
 * Plugin may not add a column here; a Project may add columns to its own tables freely.
 */

/**
 * The Store — the single commercial identity this deployment represents.
 *
 * A **singleton**, enforced in DDL rather than by convention: the primary key is a boolean
 * pinned to `true`, so the table can physically hold at most one row and there is no
 * identifier for anything else to point at. That is deliberate. One deployment serves
 * exactly one Store (ADR-0005), so the Store is never a scoping key, never a foreign key on
 * another entity, and never appears in a `where` clause. If it starts to, multi-tenancy is
 * being smuggled in.
 */
export const store = pgTable(
  "core_store",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    name: text("name").notNull(),
    /** ISO 4217, e.g. `USD`. The Store's default — Regions carry their own, later. */
    defaultCurrency: text("default_currency").notNull(),
    /**
     * ADR-0004's cheap escape hatch: unindexed and untyped by design, for the case where
     * someone just needs to stash a field. A Plugin that needs an index or a type needs its
     * own table.
     */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("core_store_is_singleton", sql`${table.singleton}`),
    check(
      "core_store_currency_is_iso4217",
      sql`char_length(${table.defaultCurrency}) = 3`,
    ),
  ],
);

export type StoreRow = typeof store.$inferSelect;

/**
 * A named Role, carrying a **permission set** (ADR-0027).
 *
 * Permissions are a flat set of strings on the Role, not a table of grants against
 * individual rows. That is the decision, not an abbreviation of one: per-resource ACLs are
 * the rabbit hole ADR-0027 names, and a route asks "does this Role hold `store:read`" once,
 * rather than asking a question per resource it touches. Subdividing a Role later is adding
 * rows here; retrofitting row-level grants would not be.
 *
 * There is no Store reference and no store id. A Role belongs to the deployment, and the
 * deployment is one Store (ADR-0005).
 */
export const role = pgTable("core_role", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stable and human-meaningful — `owner`. What a Merchant is created against. */
  name: text("name").notNull().unique(),
  /**
   * The permission set. `text[]` rather than a join table, because a set is what it is: it
   * is read whole on every request and never queried across Roles.
   */
  permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RoleRow = typeof role.$inferSelect;

/**
 * A Merchant — a person who operates the Store through the Admin (`CONTEXT.md`).
 *
 * This is **not** a general-purpose account table, and must not become one. A Shopper never
 * touches kobai: Core stores no Shopper credential, and password-based Shopper login is a
 * Plugin if it is ever wanted (ADR-0020). A single `user` table serving both audiences is
 * precisely the mistake — it would put a Shopper's password in Core's care by accident.
 *
 * No Store reference and no store id, for the same reason as the Role above.
 */
export const merchant = pgTable("core_merchant", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Normalised to lowercase before it is written, so `unique` means what it appears to. */
  email: text("email").notNull().unique(),
  /**
   * An argon2id digest, and never the password. The column holds a value that cannot be
   * reversed and is useless replayed against anything else — a database dump discloses no
   * credential.
   */
  passwordHash: text("password_hash").notNull(),
  roleId: uuid("role_id")
    .notNull()
    // `restrict`: deleting a Role out from under the Merchants holding it would leave them
    // authenticated with no permissions at all, which is a confusing way to lose access.
    .references(() => role.id, { onDelete: "restrict" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MerchantRow = typeof merchant.$inferSelect;

/**
 * A signed-in Merchant's session — the thing that authenticates an admin request.
 *
 * Sessions are rows rather than signed, self-describing tokens because signing out has to
 * take effect *immediately*: a stateless token stays valid until it expires no matter what
 * the server thinks of it, and "sign out" would become "please stop using this". Deleting a
 * row is the whole implementation of revocation.
 *
 * What is stored is a SHA-256 of the token, never the token. Read access to this table
 * therefore hands an attacker nothing to present — the same property the password column
 * has, for the same reason.
 */
export const session = pgTable(
  "core_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      // A deleted Merchant's sessions go with them, rather than outliving the account.
      .references(() => merchant.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    /** Absolute. Past this instant the session is over, attended or not. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Signing in clears that Merchant's sessions that have already run out, which is a
    // delete by `merchant_id`.
    index("core_session_merchant_idx").on(table.merchantId),
  ],
);

export type SessionRow = typeof session.$inferSelect;
