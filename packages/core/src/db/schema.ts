import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Core's tables. Every one of them is prefixed `core_`, which is what this package's
 * `tablesFilter` is scoped to.
 *
 * Core's schema shape is explicitly **not** part of the stability promise (ADR-0003). A
 * Plugin may not add a column here; a Project may add columns to its own tables freely.
 *
 * **`updated_at` is advanced by a database trigger, and there is nothing about that in this
 * file** (ADR-0037). Drizzle's `$onUpdate` would fire only for writes going through this
 * package's query builder, and under ADR-0004 the writers Core does not mediate — a Project,
 * a Plugin, a hand-run `UPDATE` — are the normal case. So a table added here that carries
 * `updated_at` needs a `--custom` migration attaching `core_set_updated_at` to it, the way
 * `migrations/0009_updated_at_triggers.sql` does. Forgetting turns
 * `packages/core/src/db/updated-at.test.ts` red, naming the table.
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
 *
 * **No `updated_at`, deliberately** — the one Core table without one (ADR-0037 attaches the
 * trigger by sweeping for the column, so this table is simply not swept). A session is written
 * for one reason only, which is that it was used, and `expires_at` already says when: it is
 * the last request plus the idle window. A second column would record the same fact in a
 * second place and pay a trigger on every extension to keep it there (ADR-0045).
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
    /**
     * When this session runs out if nobody uses it — and it **moves**.
     *
     * A request that finds the session live pushes this forward, so the column records the
     * end of an idle window rather than a lifetime fixed at sign-in (ADR-0045). It is the one
     * column in Core a read path writes, and `auth/session.ts` owns both halves of that.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * When the Merchant signed in — and therefore the anchor of the absolute cap, which no
     * amount of activity can slide. Read on the authentication path, not only for the record.
     */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Signing in clears that Merchant's sessions that have already run out, which is a
    // delete by `merchant_id`.
    index("core_session_merchant_idx").on(table.merchantId),
  ],
);

export type SessionRow = typeof session.$inferSelect;

/**
 * An API key — the credential the **store surface** is gated by (ADR-0020).
 *
 * Not a second kind of Merchant session, and deliberately not in the same table: a Session
 * is a person who signed in, expires on its own, and carries a Role; a key is a deployment
 * a Developer wired up, lives until it is revoked, and carries no Role at all. Merging them
 * would put "which permissions does a storefront hold" on the same axis as "which
 * permissions does a person hold", and there is no Shopper in Core for it to answer about
 * (ADR-0020).
 *
 * What is stored is a SHA-256 of the key and never the key — the same property the password
 * and session-token columns have, for the same reason: a dump of this table hands an
 * attacker nothing they can present. The consequence is that a key is shown once, at
 * creation, and cannot be recovered afterwards.
 *
 * `kind` is `publishable` or `secret`, and it is a *record* of a distinction the key value
 * already carries in its prefix (spec story 45). Reading it needs no database lookup, which
 * is the point — a Developer must be able to see that a key is secret while looking at the
 * string they are about to paste into a browser bundle.
 */
export const apiKey = pgTable(
  "core_api_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What the key is for, so a Merchant can tell which one to revoke. */
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    /** SHA-256 of the whole key, prefix included. Unique, so it is also the lookup index. */
    tokenHash: text("token_hash").notNull().unique(),
    /**
     * When the key stopped working, or null while it still does. Revocation is a column
     * rather than a delete because a Merchant asking "was this key ever used here" after an
     * incident should not be answered by an absence.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // In DDL rather than only in TypeScript: a third kind would need a decision about where
    // it may safely be put, and that decision should not be reachable by an insert.
    check("core_api_key_kind_is_known", sql`${table.kind} in ('publishable', 'secret')`),
  ],
);

export type ApiKeyRow = typeof apiKey.$inferSelect;

/**
 * A Product — a catalog entry a Merchant manages and a Shopper browses.
 *
 * It carries no price, no SKU and no stock, because it is **never sellable in itself**
 * (ADR-0008). Everything a Shopper actually buys hangs off the Variant below, and a Product
 * with no options at all still gets exactly one of those. That uniformity is the decision:
 * a model where a Product is sometimes sold directly and sometimes through Variants buys one
 * saved row and pays for it with a permanent branch in every catalog query, cart line,
 * inventory check and report.
 *
 * No Store reference, for the same reason as every other table here (ADR-0005).
 */
export const product = pgTable("core_product", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * A column, and a Translation table is what ADR-0022 and `CONTEXT.md` say translatable
   * text eventually wants instead. This slice has no Translation in it — the ticket names
   * Translations among the things that must not appear — so the column stands, and moving it
   * is the migration that ADR pays for by being written now rather than after a catalog,
   * a cart and an order history reference it.
   */
  title: text("title").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProductRow = typeof product.$inferSelect;

/**
 * A Variant — **the sellable thing**, carrying the SKU (ADR-0008).
 *
 * Every Product has at least one, which is a rule the schema can only half state: the
 * foreign key makes a Variant impossible without a Product, and the API is what makes a
 * Product impossible without a Variant, because the two are created in one transaction and
 * there is no route that creates a Product alone.
 *
 * The SKU is unique across the deployment, because story 20 asks for it in order to
 * *identify* a Variant, and an identifier that two Variants can share identifies nothing.
 */
export const variant = pgTable(
  "core_variant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      // A deleted Product takes its Variants with it. The alternative is an orphan Variant,
      // which is a sellable thing belonging to no catalog entry.
      .references(() => product.id, { onDelete: "cascade" }),
    sku: text("sku").notNull().unique(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Reading a Product reads its Variants by `product_id`, which is the catalog's hottest
    // query and the one a storefront makes on every page.
    index("core_variant_product_idx").on(table.productId),
  ],
);

export type VariantRow = typeof variant.$inferSelect;

/**
 * A Price — **a row, not a column** (ADR-0008).
 *
 * This slice writes one row per Variant, and the shape is the whole point of the ticket: a
 * second currency, a sale price, a quantity break, a Region- or Channel-constrained price
 * are each one more row plus one more nullable constraint column, rather than a migration
 * across a catalog, a cart, an order history and everything reporting on them. The cost of
 * being right early is one join.
 *
 * Nothing here constrains *which* Price applies, because nothing in this slice can: Region,
 * Channel, quantity and customer group are the constraint columns that arrive with them, and
 * resolving a Price by best match is a Workflow rather than a column read.
 */
export const price = pgTable(
  "core_price",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      // Prices belong to the Variant they price and outlive it in no useful sense.
      .references(() => variant.id, { onDelete: "cascade" }),
    /**
     * The amount in the **minor units** of `currency` — 1250 is `USD` 12.50, and 1250 is
     * `JPY` 1250, because how many minor units make a major one is a property of the
     * currency rather than of this column.
     *
     * An integer rather than a float, because money in binary floating point is wrong by
     * construction, and `bigint` rather than `integer` because a 32-bit column caps a
     * two-decimal currency at about 21 million and a zero-decimal one much sooner.
     */
    amount: bigint("amount", { mode: "number" }).notNull(),
    /** ISO 4217, e.g. `USD`. In this slice, always the Store's default. */
    currency: text("currency").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Resolution reads every Price of one Variant and picks among them, so this index is
    // what makes "a row, not a column" cost a join rather than a scan.
    index("core_price_variant_idx").on(table.variantId),
    // No unique constraint on (variant, currency): several Prices per Variant is the
    // representable shape ADR-0008 asks for, and what distinguishes them is constraint
    // columns this slice does not have yet.
    check("core_price_amount_is_not_negative", sql`${table.amount} >= 0`),
    check("core_price_currency_is_iso4217", sql`char_length(${table.currency}) = 3`),
  ],
);

export type PriceRow = typeof price.$inferSelect;

/**
 * A Cart — a Shopper's **mutable, disposable, unauthoritative** selection before purchase
 * (`CONTEXT.md`, ADR-0009).
 *
 * Its own table rather than an Order carrying a status, which is the whole of ADR-0009's
 * first decision: the two are governed by opposite rules — one is expected to change and be
 * thrown away, the other must never change again — and one table cannot enforce both.
 *
 * **`id` is the capability.** A storefront addresses a Cart by this value and holds no other
 * authority over it, because there is no Shopper session to hang one off and there must never
 * be one (ADR-0020). `gen_random_uuid()` is 122 bits from the platform CSPRNG, so the value
 * encodes nothing, sorts by nothing, and cannot be walked from a Cart somebody does hold; and
 * there is deliberately no route that lists Carts, so there is nothing to enumerate either.
 *
 * **The Shopper reference is two nullable columns and never a credential.** ADR-0020 has Core
 * store a reference — keyed by email, with an optional external identity — and trust the
 * identity a storefront asserts *over a secret key*. So there is no password here, no Shopper
 * table, and no assumption anywhere that a Shopper is authenticated: both columns are null on
 * the ordinary path, which is a guest.
 */
export const cart = pgTable("core_cart", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * When this Cart stops being placeable — a **lifetime** fixed at creation, not an idle
   * window (contrast `core_session`, ADR-0045). "Abandoned" is then measured from when the
   * Cart was made, and no amount of touching it keeps one alive forever.
   *
   * Nothing deletes the row when it passes. ADR-0028 lists abandoned cart as a first-party
   * Plugin and a Plugin cannot recover what Core has deleted, so expiry is a fact about the
   * row rather than the absence of one.
   */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** The Shopper reference's key. Null for a guest, which is the ordinary case (ADR-0020). */
  shopperEmail: text("shopper_email"),
  /** The Shopper's identity in whatever system the storefront actually authenticates against. */
  shopperExternalId: text("shopper_external_id"),
  /**
   * ADR-0004's escape hatch, and on a Cart it is load-bearing rather than cheap: ADR-0013
   * has a Project's replaced Step read its inputs from here, so this is the door a Shopper's
   * unmodelled choice comes through.
   */
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CartRow = typeof cart.$inferSelect;

/**
 * A Line Item on a Cart — one Variant, and how many of it.
 *
 * It carries **no snapshot**, which is the asymmetry ADR-0009 asks for: an Order's Line Items
 * snapshot title, SKU and price as at capture precisely so history cannot be rewritten, and a
 * Cart's are the opposite kind of row — unauthoritative, re-priced whenever they are read
 * about, and free to follow a catalog that changes under them.
 *
 * **One line per Variant, in DDL.** Adding a Variant already on the Cart raises the quantity
 * rather than writing a second line, and the unique constraint is what makes that an upsert
 * instead of a read followed by a write — two requests adding the same Variant at the same
 * instant would otherwise both find nothing and both insert.
 */
export const cartLineItem = pgTable(
  "core_cart_line_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartId: uuid("cart_id")
      .notNull()
      // A Cart's lines are the Cart. Nothing outlives it, because nothing else refers to them.
      .references(() => cart.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      // `cascade`, and it is safe here for the reason it would be wrong on an Order: a Cart
      // Line Item *is* a live reference to the catalog, so a deleted Variant is a selection
      // that no longer exists. ADR-0009 keeps catalog data freely deletable by making an
      // Order's lines depend on none of it, and this row is not an Order's.
      .references(() => variant.id, { onDelete: "cascade" }),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Reading a Cart reads its lines by `cart_id`, and this is also what makes "the same
    // Variant twice is one line" a constraint rather than a convention.
    uniqueIndex("core_cart_line_item_cart_variant_idx").on(table.cartId, table.variantId),
    check("core_cart_line_item_quantity_is_positive", sql`${table.quantity} > 0`),
  ],
);

export type CartLineItemRow = typeof cartLineItem.$inferSelect;
