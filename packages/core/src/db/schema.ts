import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
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

/**
 * An Order — the **immutable financial record of a completed purchase** (`CONTEXT.md`,
 * ADR-0009).
 *
 * The opposite kind of row to the Cart above, and its own table for that reason: one is
 * expected to change and be thrown away, the other must never change again, and a single
 * table with a status column cannot enforce both. Nothing in Core updates a row here, and
 * a Return is its own entity referencing this one rather than an edit to it.
 *
 * **It references the Cart it was placed from and nothing else that could restate it.** The
 * Shopper reference, the currency and the total are copies taken at Capture, so a Cart edited
 * — or, later, deleted by an abandoned-cart Plugin — leaves this record saying exactly what it
 * said the day it was written.
 *
 * **`updated_at` is here on an immutable record on purpose.** Core writes this row once and
 * never again, so the column should equal `created_at` forever — which is precisely what makes
 * it worth carrying: ADR-0037 puts the advance in a trigger because the writers Core does not
 * mediate are the normal case, so `updated_at > created_at` on an Order is visible evidence
 * that somebody wrote to a row ADR-0009 says is never written to. A column nothing should ever
 * move is a tamper detector rather than a formality.
 */
export const order = pgTable(
  "core_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The **Order number** — human-facing, distinct from `id`, monotonic, and **not promised
     * gapless** (`CONTEXT.md`).
     *
     * A sequence rather than a count of the rows: counting is a read followed by a write, which
     * two simultaneous Captures both lose, and a sequence is the one mechanism Postgres will not
     * hand the same value out of twice. What that costs is the gaps — a sequence advances even
     * for a transaction that rolls back — and the gaps are exactly what is not promised, because
     * gapless numbering is an invoicing requirement and invoicing is not Core's. Promising it
     * would mean serialising every Capture behind one lock forever.
     *
     * Per Store, which needs no column: one deployment is one Store (ADR-0005).
     */
    number: bigserial("number", { mode: "number" }).notNull().unique(),
    /**
     * The Cart this Order was placed from — for navigation, never for arithmetic.
     *
     * `set null` rather than `cascade` or `restrict`: a Cart is disposable and an Order is not,
     * so the Cart going away must leave this record whole, and it must not be able to hold a
     * Cart's rows hostage either. Everything a person reads is copied onto this row and the
     * Line Items below, so losing the reference loses nothing but the trail back.
     */
    cartId: uuid("cart_id").references(() => cart.id, { onDelete: "set null" }),
    /** The Shopper reference as at Capture. Null for a guest, which is the ordinary case. */
    shopperEmail: text("shopper_email"),
    shopperExternalId: text("shopper_external_id"),
    /** ISO 4217, copied at Capture — the currency every amount on this Order is in. */
    currency: text("currency").notNull(),
    /**
     * What was charged, in the minor units of `currency`. The sum of the Line Items' totals
     * today; Adjustments arrive as their own lines and are accounted for here (ADR-0022).
     */
    total: bigint("total", { mode: "number" }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** The moment of **Capture** — when this Order came into existence and became immutable. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * **One Order per Cart, in DDL** — which is what makes a Cart spent by the Order it became
     * (#102).
     *
     * The constraint is the decision rather than a guard on it. Two requests placing one Cart
     * at the same instant both find no Order and both write one; a unique index is the check
     * and the claim in a single operation, so the second insert waits on the first and is then
     * told the value is taken — the same shape as the Cart's own one-line-per-Variant index,
     * and the one ADR-0018 asks for wherever something scarce is claimed.
     *
     * A `null` here is a Cart that has since been deleted, and Postgres treats two nulls as
     * distinct — so Orders outliving their Carts do not collide with each other.
     */
    uniqueIndex("core_order_cart_idx").on(table.cartId),
  ],
);

export type OrderRow = typeof order.$inferSelect;

/**
 * A Line Item on an Order — and it holds a **snapshot** (ADR-0009).
 *
 * Title, SKU, unit price and tax as at Capture are columns here rather than a join, which is
 * the whole of ADR-0009's second decision: a Line Item that read the catalog live would let
 * renaming a Product rewrite history, deleting a Variant destroy an Order, and repricing
 * falsify past revenue — the one failure this schema is most likely to be talked into and the
 * one that cannot be repaired afterwards, because the original values are simply gone.
 *
 * `variant_id` is therefore nullable and `set null`, and the two facts are the same fact:
 * catalog data stays freely deletable *because* an Order depends on none of it, and a
 * reference that could refuse a delete — or take an Order's line with it — would be that
 * dependency in a new place. It is for navigation only, never for display or arithmetic.
 */
export const orderLineItem = pgTable(
  "core_order_line_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      // An Order's lines are the Order, exactly as a Cart's are the Cart.
      .references(() => order.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => variant.id, { onDelete: "set null" }),
    /** The Product's title as at Capture. Renaming the Product does not reach this. */
    title: text("title").notNull(),
    /** The Variant's SKU as at Capture, for the same reason. */
    sku: text("sku").notNull(),
    /** What one of it cost, in minor units — the Price resolved at Capture, not read now. */
    unitAmount: bigint("unit_amount", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    /**
     * Tax on this line, in minor units.
     *
     * Zero until the tax spec puts a real Step in `calculate-tax`, and modelled now rather
     * than then (ADR-0022): a snapshot that gained a tax figure later would change what every
     * Order written before it means, and there would be no honest value to backfill.
     */
    tax: bigint("tax", { mode: "number" }).notNull().default(0),
    /** What this line came to. Stored rather than derived: a snapshot recomputed is not one. */
    total: bigint("total", { mode: "number" }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Reading an Order reads its lines by `order_id`, which is every view of one.
    index("core_order_line_item_order_idx").on(table.orderId),
    check("core_order_line_item_quantity_is_positive", sql`${table.quantity} > 0`),
  ],
);

export type OrderLineItemRow = typeof orderLineItem.$inferSelect;

/**
 * An **Adjustment** — a discount or a surcharge, held as its own row (ADR-0022).
 *
 * A row rather than a column on the thing it adjusts, and that is the entire decision. An
 * Adjustment folded into a `unit_amount` leaves an Order recording a price that was never the
 * price, with no record of what moved it or why, and every figure derived from it — the tax
 * base, a refund, revenue — computed from a number nobody was charged. ADR-0022 calls that a
 * retrofit that touches everything, which is why the shape is here before the feature is.
 *
 * **It hangs off the Order, and optionally off one of its Line Items.** `order_line_item_id` is
 * null for an Adjustment on the Order as a whole — a basket-wide voucher, a delivery surcharge —
 * and set for one that belongs to a single line, which is what makes it part of what that line
 * came to and so part of what a Return for that line refunds. `order_id` is on both, because
 * every Adjustment belongs to exactly one Order and reading one should not need a join to find
 * that out.
 *
 * Immutable like everything else about an Order, and carrying `updated_at` for the same reason
 * `core_order` does: a column nothing should ever move is a tamper detector.
 */
export const orderAdjustment = pgTable(
  "core_order_adjustment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      // An Order's Adjustments are the Order, exactly as its Line Items are.
      .references(() => order.id, { onDelete: "cascade" }),
    /** The line this adjusts, or null for an Adjustment on the Order as a whole. */
    orderLineItemId: uuid("order_line_item_id").references(() => orderLineItem.id, {
      onDelete: "cascade",
    }),
    /**
     * Where this one sits in the list its Step produced, within its Order or its Line Item.
     *
     * Stored because there is nothing else to order by. Capture writes every Adjustment in one
     * transaction, so `created_at` is identical across all of them and the tie would fall to a
     * random uuid — an Order would report its Adjustments in a different order every time it
     * was read, and in a different order from the one they were applied in. Two Steps that each
     * add a surcharge compose in a definite order, and this is that order, kept.
     */
    position: bigint("position", { mode: "number" }).notNull(),
    /** Machine-readable and the Step's own. Core defines none and validates none. */
    code: text("code").notNull(),
    /** For a person — what a Shopper reads on a confirmation and a Merchant in the Admin. */
    description: text("description").notNull(),
    /**
     * **Signed** minor units of the Order's currency: negative discounts, positive surcharges.
     *
     * One signed column rather than a kind and a magnitude, so that a total is a sum in both
     * directions rather than a branch that eventually gets the sign wrong somewhere.
     */
    amount: bigint("amount", { mode: "number" }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Reading an Order reads its Adjustments by `order_id`, which is every view of one.
    index("core_order_adjustment_order_idx").on(table.orderId),
  ],
);

export type OrderAdjustmentRow = typeof orderAdjustment.$inferSelect;

/**
 * A **Payment** — the record that money was taken for an Order (ADR-0053).
 *
 * Core's row, behind an interface Core does not implement. Omit the record and an Order holds no
 * account of the money and a Return has nothing to refund against, which is ADR-0028's membership
 * test answered; ship a provider and dependency substitution would still have no implementation
 * from outside Core, which is why there is none.
 *
 * **Everything here is a copy, and `reference` is the only handle out.** `provider` is what took
 * the money and `reference` is that system's own name for the payment — a `PaymentIntent` id, an
 * invoice number. Core stores both and parses neither: a deployment that changes provider still
 * has to know which one is holding the money behind an Order placed last year, and a reference
 * without the system that issued it means nothing.
 *
 * **Written in the same transaction as the Order**, so neither can exist without the other. The
 * payment itself moved a moment earlier, outside any transaction, which is exactly why
 * `take-payment` is the one Step of `place-order` that carries a compensation.
 *
 * `updated_at` is here on a record nothing updates, for `core_order`'s reason: a column that
 * should equal `created_at` forever is a tamper detector rather than a formality.
 */
export const payment = pgTable(
  "core_payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      // An Order's Payment is the Order's, exactly as its Line Items are.
      .references(() => order.id, { onDelete: "cascade" }),
    /** What took the money — the provider's own `name`, as it was wired at the time. */
    provider: text("provider").notNull(),
    /** The provider's handle on this payment. Opaque to Core, and what a refund is asked against. */
    reference: text("reference").notNull(),
    /** What was taken, in the minor units of `currency`. The Order's total, as at Capture. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    /**
     * Whether the money **arrived**, or was only arranged for — what the provider said when it
     * answered, and never touched again.
     *
     * `true` by default because that is what `ok: true` has always meant on `PaymentOutcome`:
     * *takes the money*. A provider that arranges instead of taking — an invoice, a bank
     * transfer, the reference Project's `manual` one — answers `received: false`, and this is
     * where that stops being lost. Without it every Order in the Admin looks settled, and a
     * Merchant cannot tell a completed sale from one still owed for.
     *
     * A record and not a status: an Order is immutable (ADR-0009), so nothing in Core moves this
     * afterwards, and collecting the money is still something a Merchant does out of band.
     */
    received: boolean("received").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * **One Payment per Order, in DDL.**
     *
     * `place-order` takes exactly one payment for exactly one Order, so this says in the schema
     * what the Workflow does — and a second row arriving from anywhere is a Shopper charged
     * twice, which is the failure worth refusing at the constraint rather than detecting later.
     * Split tender is not built, and when it is, this index is the decision it has to reopen.
     */
    uniqueIndex("core_payment_order_idx").on(table.orderId),
  ],
);

export type PaymentRow = typeof payment.$inferSelect;

/**
 * A **client-supplied idempotency key**, and the Order it produced (#102).
 *
 * What it is for is one fact a request cannot carry: that a `POST /store/orders` this
 * storefront gave up waiting for is the same intention as the one it is sending now. A retry is
 * indistinguishable from a fresh purchase at the network — the timeout happens on the way back —
 * so a key the caller chooses is the only thing that can tell them apart, and without one a
 * retry after a timeout is a second charge.
 *
 * **The row is claimed before the Workflow runs and completed after it.** That order is what
 * makes it work: `key` is unique, so of two simultaneous requests exactly one writes this row,
 * and the other finds it and is refused rather than placing anything. `order_id` is null while
 * the first is still running and set the moment it captures — so "another request is using this
 * key" and "this key already produced that Order" are different states with different answers.
 *
 * **No `updated_at`, deliberately** — the second Core table without one, and for `core_session`'s
 * reason (ADR-0037, ADR-0045). This row is written twice for exactly one reason, which is that
 * the Order was captured, and `order_id` records that fact along with the Order's own
 * `created_at` saying when. A column advancing on the same write would be that fact in a second
 * place, kept there by a trigger on every claim.
 *
 * **It expires, and nothing sweeps it yet.** `expires_at` is what stops a key being held forever
 * by a request whose process died mid-run: past it, the row no longer binds and the next claim
 * on that key takes it over. The rows themselves accumulate — one per placement attempt, each a
 * few hundred bytes beside the Order it names — and deleting them is a background sweep kobai
 * does not have until the Reservation sweeper arrives (#98). Until then this grows with Orders
 * rather than without bound, which is the same rate the Orders themselves do.
 */
export const idempotencyKey = pgTable(
  "core_idempotency_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The value the caller chose, stored as they wrote it.
     *
     * Not hashed, unlike every other credential-shaped column here: an idempotency key opens
     * nothing and authorises nothing — a caller holding one can learn only about the Order they
     * placed with it, and they already have that. What it needs to be is comparable, and an
     * unguessable value is the caller's business rather than kobai's.
     */
    key: text("key").notNull().unique(),
    /**
     * A digest of the request this key was first used with.
     *
     * The same key with a *different* body is a programming error rather than a retry, and
     * answering it with somebody else's Order would be worse than failing — so what the first
     * request asked for has to be recoverable. A digest rather than the body, because comparing
     * is all this is for and a stored copy of every request is a second place a Shopper's data
     * lives.
     */
    fingerprint: text("fingerprint").notNull(),
    /**
     * The Order this key produced, or null while the request that claimed it is still running.
     *
     * `cascade`, so a key cannot outlive the Order it names and go on replaying a record that is
     * no longer there. Nothing in Core deletes an Order (ADR-0009); this is what the column
     * means if anything ever does.
     */
    orderId: uuid("order_id").references(() => order.id, { onDelete: "cascade" }),
    /** When this key stops binding, and may be claimed again. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Expired rows are what a sweep will delete, and what a claim looks past.
    index("core_idempotency_key_expires_idx").on(table.expiresAt),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKey.$inferSelect;

/**
 * **Inventory** — the countable stock of a physical Variant (`CONTEXT.md`, ADR-0018).
 *
 * One of the two scarce resources a Reservation claims; Capacity is the other, and it is not
 * this table. Both go through one interface (`reservation/provider.ts`) precisely so that the
 * second one arrives as another provider rather than as another mechanism — so nothing here is
 * reached except through that interface, and the Inventory provider is the only thing that
 * writes these two numbers.
 *
 * **A row is what makes a Variant tracked, and its absence is not zero.** A Variant nobody has
 * counted is not a Variant with none left: the first sells freely and the second sells to
 * nobody, and a table where "no row" meant "no stock" could not tell them apart. So a digital
 * Variant simply has no row, and stock arrives when a Merchant says it does.
 *
 * **Two columns rather than one, and `available` is neither of them.** `on_hand` is what the
 * Store physically has and only Capture moves it; `reserved` is how much of that is claimed by
 * a Reservation still in flight. What is left to sell is `on_hand - reserved`, derived on
 * every read rather than stored, because a third column would be a number that can disagree
 * with the other two — and the disagreement would be invisible until the Store oversold.
 *
 * **The check constraints are load-bearing.** ADR-0018 requires check-and-claim to be one
 * atomic operation, and the provider's `update … where on_hand - reserved >= n` is that
 * operation; these constraints are the second answer, the one that holds even for a writer
 * Core does not mediate (ADR-0004). Negative stock is not a state this table can hold.
 */
export const inventory = pgTable(
  "core_inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The Variant this counts, and exactly one row per Variant.
     *
     * Unique in DDL rather than by convention: two rows counting the same Variant would be two
     * answers to how many there are, and the claim is made by a conditional `update` that
     * would then move only one of them.
     */
    variantId: uuid("variant_id")
      .notNull()
      .unique()
      // A deleted Variant takes its stock with it. There is nothing to count once the sellable
      // thing is gone, and an Order's Line Items depend on none of this (ADR-0009).
      .references(() => variant.id, { onDelete: "cascade" }),
    /** What the Store physically has. Only Capture moves it, by consuming a Reservation. */
    onHand: bigint("on_hand", { mode: "number" }).notNull().default(0),
    /** How much of `on_hand` is claimed by a Reservation that is still held. */
    reserved: bigint("reserved", { mode: "number" }).notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("core_inventory_on_hand_is_not_negative", sql`${table.onHand} >= 0`),
    check("core_inventory_reserved_is_not_negative", sql`${table.reserved} >= 0`),
    // The one that says the Store never promises what it does not have: everything reserved is
    // something on hand.
    check(
      "core_inventory_reserved_within_stock",
      sql`${table.reserved} <= ${table.onHand}`,
    ),
  ],
);

export type InventoryRow = typeof inventory.$inferSelect;

/**
 * A **Reservation** — a claim on a scarce resource, **held** during purchase, **consumed** at
 * Capture, **released** on failure or expiry (`CONTEXT.md`, ADR-0018, ADR-0027).
 *
 * Core's record of the claim, and deliberately not the claim itself: what makes a unit
 * unavailable is the provider's own arithmetic — `core_inventory.reserved`, and whatever
 * Capacity brings — while this row says who claimed what, until when, and how it ended. The
 * split is what makes one interface with two providers possible: this table needs no column
 * added for the second one.
 *
 * **`provider` and `subject` are the whole of that generality.** `provider` names which
 * provider owns the claim (`inventory`), and `subject` is what the claim is *on*, in that
 * provider's own terms — a Variant's identifier here, and a Capacity provider's own key when
 * one arrives. `subject` is therefore text and carries no foreign key: a column referencing
 * `core_variant` would be an Inventory column on a table that is not Inventory's.
 *
 * **Its two endings are two columns, and both are timestamps.** A held Reservation has neither;
 * a consumed one has `consumed_at` and the Order that consumed it; a released one has
 * `released_at`. A single `status` would make "held" the absence of a value that has to be kept
 * in step with the provider's arithmetic, and the release path is exactly where that goes wrong:
 * a compensation and the sweeper can reach the same row at the same instant, and `update …
 * where released_at is null … returning` is what lets only one of them give the units back.
 *
 * **No `updated_at`, deliberately** — the third Core table without one, for `core_session`'s
 * reason (ADR-0037, ADR-0045). This row is written for exactly two reasons after it is created,
 * and each has its own column saying when it happened. A third column advancing on the same
 * writes would record the same fact twice and pay a trigger on every hold to keep it there.
 */
export const reservation = pgTable(
  "core_reservation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Which provider owns this claim — `inventory` today, and Capacity's when it arrives. */
    provider: text("provider").notNull(),
    /** What the claim is on, in that provider's own terms. A Variant's id, for Inventory. */
    subject: text("subject").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    /**
     * When this hold lapses, and the sweeper may give the units back.
     *
     * A TTL rather than a lifetime nobody ends (ADR-0027): a request whose process died between
     * holding and Capture would otherwise keep stock claimed for a Shopper who has gone. It is
     * generous compared with how long a placement takes, because releasing a hold out from
     * under a run that is still going is the worse mistake — that one oversells.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** When Capture took these units for good — inside the same transaction as the Order. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** When the units went back, whether by a compensation or by the sweeper. */
    releasedAt: timestamp("released_at", { withTimezone: true }),
    /**
     * The Order that consumed this Reservation, or null while it is merely held.
     *
     * `set null` rather than `cascade`: the units were taken whether or not the Order row
     * survives, and a stock record that vanished with it would leave `on_hand` short by an
     * amount nothing accounts for. Nothing in Core deletes an Order (ADR-0009); this is what
     * the column means if anything ever does.
     */
    orderId: uuid("order_id").references(() => order.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // What the sweeper scans: the lapsed ones, oldest deadline first.
    index("core_reservation_expires_idx").on(table.expiresAt),
    // Reading an Order's claims, and what a consumed Reservation is found by.
    index("core_reservation_order_idx").on(table.orderId),
    check("core_reservation_quantity_is_positive", sql`${table.quantity} > 0`),
  ],
);

export type ReservationRow = typeof reservation.$inferSelect;
