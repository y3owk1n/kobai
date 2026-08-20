import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { DRAFT, PRODUCT_STATUSES, type ProductStatus } from "../catalog/status.ts";
import { DEFAULT_FULFILMENT_STRATEGY } from "../fulfilment/strategy.ts";

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
export const role = pgTable(
  "core_role",
  {
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
  },
  (table) => [
    // `GET /admin/roles` pages by keyset (ADR-0064), and a deployment's Roles being few is not
    // the reason to skip this: the index is the clause of that contract the query rests on, and
    // `db/schema.test.ts` sweeps every paged list for it.
    index("core_role_created_at_id_idx").on(table.createdAt, table.id),
  ],
);

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
export const merchant = pgTable(
  "core_merchant",
  {
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
  },
  (table) => [
    // `GET /admin/merchants` pages by keyset, exactly as the Roles above (ADR-0064).
    index("core_merchant_created_at_id_idx").on(table.createdAt, table.id),
  ],
);

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
    // The order the list route pages in, and the columns its cursor compares (ADR-0064). Both
    // columns, in this order, because the tiebreaker is part of the ordering rather than a
    // detail of it — an index on `created_at` alone leaves the second comparison to a sort.
    // Ascending though every reader wants it descending: one direction reversed for the whole
    // ordering is a backwards scan of this same index.
    index("core_api_key_created_at_id_idx").on(table.createdAt, table.id),
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
export const product = pgTable(
  "core_product",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * A column, and a Translation table is what ADR-0022 and `CONTEXT.md` say translatable
     * text eventually wants instead. This slice has no Translation in it — the ticket names
     * Translations among the things that must not appear — so the column stands, and moving it
     * is the migration that ADR pays for by being written now rather than after a catalog,
     * a cart and an order history reference it.
     */
    title: text("title").notNull(),
    /**
     * What a Merchant says about this Product, for a Shopper to read — or `null`, which is
     * what a Product nobody has written copy for holds.
     *
     * **Nullable, and that is the whole of the migration this column cost.** A `NOT NULL`
     * would have needed ADR-0038's three steps and a backfill, and there is no value a
     * backfill could honestly write: an empty string says a Merchant wrote nothing down,
     * which is a different fact from nobody having been asked. So absence is spelled the way
     * the column already spells it.
     *
     * A column, for `title`'s reason one line up and no other: a Translation table is what
     * ADR-0022 and `CONTEXT.md` say translatable text eventually wants, this slice has no
     * Translation in it, and moving both columns at once is the migration that ADR pays for
     * by having been written before a catalog referenced either.
     */
    description: text("description"),
    /**
     * The **address** this Product is known by — `blue-poster`, so a storefront's URL is
     * `/products/blue-poster` rather than a UUID.
     *
     * Unique across the deployment, because an address two Products share addresses neither:
     * `GET /store/products/{idOrHandle}` reads anything that is not a UUID as one of these, and
     * that resolution is only statable while exactly one row can answer to it. It is the second
     * identifying string on this half of the schema and it is spelled like the first — a
     * `.unique()`, the way `core_variant.sku` is, because a SKU identifies one Variant for the
     * same reason (ADR-0008, story 20).
     *
     * **`NOT NULL` and unique on a table that already exists, which is ADR-0038's whole dance
     * and the reason this column cost three migrations rather than one.** `0036` adds it
     * nullable, `0037` backfills every row from its title with the disambiguation that makes
     * the constraint satisfiable, and `0038` is what this declaration generates: `SET NOT NULL`
     * and the unique constraint, arriving onto data that can already meet both. Reversing that
     * order is the failure the dance exists for — Postgres refuses either statement against the
     * rows a Store with traffic is already holding, and under ADR-0030 that Project gets no
     * service rather than a bad column.
     *
     * A `check` constraining its *shape* is deliberately absent. What a handle may look like is
     * a rule about a request — it is refused at 400 by `catalog/handle.ts` and may be relaxed
     * there — while a Product written before the rule existed must still be readable, and a
     * constraint is the one place a relaxation cannot reach the rows already stored.
     */
    handle: text("handle").notNull().unique(),
    /**
     * Whether a Shopper may see this Product at all — `draft`, `published` or `archived`.
     *
     * **A `DEFAULT` here and a backfill in `0040`, which is the whole reason this column cost
     * three migrations** (ADR-0038). A Product created from now on is a `draft`, because
     * publishing is a decision a Merchant makes rather than a side effect of creating; every
     * Product that already existed had to become `published`, because it had been on sale the
     * whole time. Two different values, so one of them is this `.default()` — visible, and right
     * for every row written from here on — and the other is an `UPDATE` in a `--custom`
     * migration. A default that has to be dropped once it has done its job was never a default.
     *
     * **The `check` is the opposite judgement from `handle`'s two lines up, and from
     * `core_variant.fulfilment_strategy`'s** (ADR-0014). Those are open sets: what a handle may
     * look like is a rule about a *request* and may be relaxed, and a Strategy is named by
     * whatever key a deployment wired. These three words are Core's own and nothing outside Core
     * can invent a fourth, so a row holding one is a bug rather than a Merchant's choice — which
     * is exactly the case `core_api_key.kind` carries a `check` for. `catalog/status.ts` is the
     * one list all of this is written from, so a fourth status is one edit there and a migration.
     *
     * The store surface answers `published` and nothing else, and it does that in the route
     * rather than by offering a filter: a client that could ask for drafts is a client that will.
     */
    status: text("status").$type<ProductStatus>().notNull().default(DRAFT),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // What `GET /admin/products` pages along — see `core_api_key`'s for why both columns.
    index("core_product_created_at_id_idx").on(table.createdAt, table.id),
    // Written from `catalog/status.ts`'s one list rather than retyped, so a fourth status is one
    // edit there and a migration — and `sql.raw`, because a `${value}` in a Drizzle template is
    // a bound **parameter**: the generated DDL came out as `in ($1, $2, $3)`, which is not a
    // constraint anything could enforce. The words are compile-time constants of Core's own,
    // which is what makes quoting them by hand here safe.
    check(
      "core_product_status_is_known",
      sql`${table.status} in (${sql.raw(PRODUCT_STATUSES.map((status) => `'${status}'`).join(", "))})`,
    ),
  ],
);

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
    /**
     * The **Fulfilment Strategy** this Variant is delivered by, **by name** (ADR-0014,
     * ADR-0052).
     *
     * A name and not an enum, and that is the decision rather than a shortcut to one: the set is
     * open, Core ships `physical` and `digital`, and a Plugin's Strategy is wired by the Project
     * under whatever key it likes. A `check` constraining this column to Core's two would be the
     * closed set ADR-0014 rules out, in the one place it would be hardest to remove.
     *
     * Nothing about *how* it is fulfilled is stored beside it. Does it ship, does it consume
     * stock, does it have a Lead Time are questions the Strategy answers when Core asks — see
     * `fulfilment/strategy.ts` — so a column here would be the flags ADR-0014 exists to avoid.
     *
     * The default is `physical` because that is what every Variant written before this column
     * existed is, and what a Variant created without an opinion should be. It is a real default
     * rather than a backfill (ADR-0038): it is right for future rows too, which is why one
     * generated migration adds this column rather than three.
     */
    fulfilmentStrategy: text("fulfilment_strategy")
      .notNull()
      .default(DEFAULT_FULFILMENT_STRATEGY),
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
 * An **option** a Product is chosen by — Size, Colour — in the order a Merchant put them in.
 *
 * A row rather than a column for ADR-0008's reason one table up: a Product that comes in three
 * sizes and two colours is five rows here, and a Product that comes in one thing is none. A pair
 * of `option_1`/`option_2` columns would have been a migration the first time somebody sold a
 * poster in a size, a colour and a finish, and a `jsonb` array would have been the same fact
 * with nothing able to point at one of them — which {@link variantOptionValue} has to.
 *
 * **`position` is a column because the order is a Merchant's decision** (story 11). Size before
 * Colour is how a storefront draws the picker, and a storefront that had to invent the order
 * would draw a different one from the Admin. It is rewritten from the list a request carries
 * every time the set is declared or corrected, so it is dense and zero-based by construction
 * rather than by constraint — the ordering below ends in `id` all the same, because a total
 * order is not something a convention should be trusted for.
 *
 * **No unique index on `(product_id, name)`, and that is a decision rather than an oversight.**
 * Postgres checks a unique constraint per statement, so renaming Size to Colour while a Colour
 * is still there — a swap, which is a cycle — would be refused halfway through a correction
 * that is perfectly well formed. What keeps the names distinct instead is that every write here
 * replaces the whole list, from a list `catalog/options.ts` has already refused a repeat in, and
 * does it under that module's `lockProductOptions` — a `pg_advisory_xact_lock` per Product, so
 * two corrections serialise rather than both reading the old list. A **row** lock cannot stand in
 * for it: `lockProduct` is `for share`, and two `FOR SHARE` holders do not conflict.
 */
export const productOption = pgTable(
  "core_product_option",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      // A deleted Product takes its options with it, and their values after them — an option
      // belonging to no Product is a question nothing asks.
      .references(() => product.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Zero-based, and rewritten from the request's own order every time the list is declared. */
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // How every read of a Product asks for them: its options, in the order it declared them.
    index("core_product_option_product_position_idx").on(table.productId, table.position),
  ],
);

export type ProductOptionRow = typeof productOption.$inferSelect;

/**
 * A Variant's **value** for one of its Product's options — `Size` is `M`, `Colour` is `Red`.
 *
 * One row per Variant per option, which is what lets a storefront map a chosen combination to a
 * SKU: it has the Product's options in order and each Variant's value for each, so the
 * combination that no Variant answers is simply absent (story 21) rather than an error to
 * interpret.
 *
 * **The unique index is what makes a Variant's answer single.** Two rows for one Variant and one
 * option would be two answers to "what size is this", and nothing reading them could say which
 * was meant. It is safe to declare here in the way `(product_id, name)` above is not: a Variant's
 * values are written by deleting every row it has and inserting the new set, so no rename can
 * collide with a row on its way out.
 *
 * The value is `text` and Core has no opinion about it. `M`, `Medium` and `medium` are three
 * different values because a Merchant said three different things, and a normalisation here
 * would be a rule about a Store's own vocabulary in the one place it could not be relaxed.
 */
export const variantOptionValue = pgTable(
  "core_variant_option_value",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      // A deleted Variant takes its answers with it.
      .references(() => variant.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      // An option a Product no longer declares takes every Variant's answer to it with it,
      // which is what makes removing one an ordinary correction rather than a cleanup.
      .references(() => productOption.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("core_variant_option_value_variant_option_idx").on(
      table.variantId,
      table.optionId,
    ),
  ],
);

export type VariantOptionValueRow = typeof variantOptionValue.$inferSelect;

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
 * **Media** — a Merchant-supplied catalog asset, and Core's record of one (ADR-0015).
 *
 * The row is the record; the bytes are somewhere else entirely. `storage_key` is the only
 * thing that reaches across, and what it means is the deployment's `MediaStorage`'s business
 * and nothing this table has an opinion about — a path under a directory for the storage Core
 * ships, an object key for an S3 one, whatever a CDN's driver hands back. **There is no `url`
 * column, and its absence is the decision** (`media/storage.ts`): a URL stored at upload is a
 * copy of an answer the storage is still able to give, so a Store that puts a CDN in front of
 * the bucket it already had would be left with a table full of addresses naming the old one.
 * The storage is asked at read time instead, and moving a deployment's Media is then copying
 * the objects rather than rewriting rows.
 *
 * It is **unique**, because it is what `GET /media/{key}` resolves — one key names one row and
 * one object, and two rows sharing one would make the byte route's answer a coin toss. That is
 * a `.unique()` on a table this migration creates, so it carries none of ADR-0038's hazard.
 *
 * **`alt` is nullable, and `width`/`height` are too, for two different reasons.** Alt text is a
 * thing a Merchant writes and may not have written yet, and an empty string would say they had.
 * The dimensions are a fact about the bytes, read out of the file's own header at upload
 * (`media/dimensions.ts`) — so `null` is the honest answer for a format kobai cannot read the
 * header of, rather than a `0` a storefront would lay out against.
 *
 * There is deliberately **no `metadata`** here, unlike every principal entity above. This slice
 * gives a Merchant one thing to say about an asset — what it shows, for somebody who cannot see
 * it — and a bag nothing on the surface can write to would be a column pretending to be an
 * escape hatch. Adding one is additive under ADR-0060 the day something needs it.
 *
 * There is no reference to a Product or a Variant on this table, in either direction, and there
 * is not going to be: what a Product or a Variant shows is {@link productMedia} and
 * {@link variantMedia}, two join tables with an order of their own — so one image leads on two
 * Products and a deleted Product takes its attachments and leaves the asset here (ADR-0082).
 */
export const media = pgTable(
  "core_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What the deployment's `MediaStorage` called the object it wrote. Opaque to Core. */
    storageKey: text("storage_key").notNull().unique(),
    /** As the upload declared it — `image/png`. Core stores it and serves it back verbatim. */
    contentType: text("content_type").notNull(),
    /** The name the Merchant's own machine gave the file, so a Media library is readable. */
    filename: text("filename").notNull(),
    /** How many bytes were stored, which is the one fact a Merchant can act on about weight. */
    byteSize: integer("byte_size").notNull(),
    /** Pixels, read from the bytes — `null` where the format's header could not be read. */
    width: integer("width"),
    height: integer("height"),
    /** What this shows, for a Shopper who cannot see it. `null` until a Merchant writes it. */
    alt: text("alt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // What `GET /admin/media` pages along — see `core_api_key`'s for why both columns.
    index("core_media_created_at_id_idx").on(table.createdAt, table.id),
  ],
);

export type MediaRow = typeof media.$inferSelect;

/**
 * Media attached to a **Product**, in the order a Merchant put it in (#255, story 9).
 *
 * A join table rather than a column on either side, for the reason a Price is a row: a Product
 * has as many images as somebody uploaded, one image may lead on two Products, and neither of
 * those is a shape a `media_id` on `core_product` can hold.
 *
 * **Two tables and not one polymorphic one**, which is the decision this table and
 * {@link variantMedia} are together. A single `core_media_attachment` carrying a `subject_type`
 * and a nullable `product_id`/`variant_id` — or worse, one `subject_id` naming either — is the
 * shape a foreign key cannot constrain, and a reference nothing constrains is exactly what
 * ADR-0004 keeps this schema relational to avoid. The cost is that the two tables are the same
 * four columns twice; what it buys is that `on delete cascade` states "a deleted Product takes
 * its attachments with it" in the database rather than in a function somebody has to remember
 * to call.
 *
 * **`position` is a column because the order is a Merchant's decision** — the first image is
 * the one that leads, and a storefront that had to invent an order would invent a different one
 * from the Admin. It is rewritten dense from the list every request carries, exactly as
 * {@link productOption}'s is, and every read orders by it and breaks the tie on `id`.
 *
 * **The unique index is what makes one image appear once on one Product.** The same Media twice
 * in a list is two positions for one picture and nothing could say which is meant; every write
 * here deletes the Product's rows and inserts the list afresh, so nothing on its way in can
 * collide with a row on its way out.
 */
export const productMedia = pgTable(
  "core_product_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      // A deleted Product takes its attachments and **not** the Media: an image is a Store's
      // asset rather than a Product's, and it may well be attached to another Product or be
      // waiting to be attached again. See ADR-0082.
      .references(() => product.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      // `restrict` and not `cascade`, and it is ADR-0082's decision rather than a default: a
      // Media that something is showing cannot be deleted out from under it, which is
      // ADR-0059's house rule — catalog deletion refuses rather than cascading — held by the
      // schema instead of by a handler. Detaching first is the repair, and it is one a Merchant
      // can carry out themselves.
      .references(() => media.id, { onDelete: "restrict" }),
    /** Zero-based, and rewritten from the request's own order every time the list is set. */
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("core_product_media_product_media_idx").on(
      table.productId,
      table.mediaId,
    ),
    // How every read of a Product asks for them: its images, in the order it set them.
    index("core_product_media_product_position_idx").on(table.productId, table.position),
  ],
);

export type ProductMediaRow = typeof productMedia.$inferSelect;

/**
 * Media attached to one **Variant**, in the order a Merchant put it in (#255, story 10).
 *
 * {@link productMedia}'s twin, and the whole of story 10: a Shopper who picks Red should see
 * the red one, so the picture belongs to the Variant rather than to the Product it hangs off.
 * It is a second table rather than a nullable `variant_id` on the first for the reason written
 * there — a column that is sometimes a Product and sometimes a Variant is a reference no
 * foreign key can hold.
 *
 * A Variant's images are its own and do not extend its Product's: a storefront shows the
 * Variant's where it has any and the Product's otherwise, which is a decision it makes with
 * both lists in front of it rather than one kobai takes on its behalf.
 */
export const variantMedia = pgTable(
  "core_variant_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      // A deleted Variant takes its attachments and not the Media, exactly as its Product does.
      .references(() => variant.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      // `restrict`, for `core_product_media`'s reason and ADR-0082's.
      .references(() => media.id, { onDelete: "restrict" }),
    /** Zero-based, and rewritten from the request's own order every time the list is set. */
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("core_variant_media_variant_media_idx").on(
      table.variantId,
      table.mediaId,
    ),
    index("core_variant_media_variant_position_idx").on(table.variantId, table.position),
  ],
);

export type VariantMediaRow = typeof variantMedia.$inferSelect;

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
 * encodes nothing, sorts by nothing, and cannot be walked from a Cart somebody does hold.
 *
 * **The public cannot enumerate them; a Merchant can** (ADR-0071). This comment used to say
 * there was deliberately no route that lists Carts, and `GET /admin/carts` reversed that
 * deliberately: a Merchant asking *why is that stock unavailable* has no other way to be told
 * that a Shopper is at their bank holding it (ADR-0070). The amended rule is that a Cart
 * identifier is a capability **Merchants hold and the public does not** — the list is behind a
 * Merchant session and `cart:read`, and nothing on the store surface enumerates anything. That
 * route is also **read-only**, so handing the capability to a Merchant hands them no way to
 * release a hold out from under the Shopper who is mid-payment.
 *
 * **The Shopper reference is two nullable columns and never a credential.** ADR-0020 has Core
 * store a reference — keyed by email, with an optional external identity — and trust the
 * identity a storefront asserts *over a secret key*. So there is no password here, no Shopper
 * table, and no assumption anywhere that a Shopper is authenticated: both columns are null on
 * the ordinary path, which is a guest.
 */
export const cart = pgTable(
  "core_cart",
  {
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
  },
  (table) => [
    // `GET /admin/carts` pages on `(created_at desc, id desc)` (ADR-0064), and this is the
    // index that ordering reads backwards — the same pair `0028` put on the three tables that
    // were paged then. Carts belong in that company rather than with Roles and Merchants: this
    // one grows without bound and takes an insert from every storefront session.
    index("core_cart_created_at_id_idx").on(table.createdAt, table.id),
  ],
);

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
    /**
     * What `GET /admin/orders` pages along — see `core_api_key`'s for why both columns.
     *
     * This is the one of the three that will matter: an Order is never deleted, this table takes
     * an insert from every placement, and a Merchant reading the books is reading the newest
     * rows of the largest table kobai has.
     */
    index("core_order_created_at_id_idx").on(table.createdAt, table.id),
  ],
);

export type OrderRow = typeof order.$inferSelect;

/**
 * A **Fulfilment** — how one part of an Order gets to the Shopper (ADR-0014).
 *
 * **Its own table rather than a column on `core_order`**, and that is the decision this ticket
 * exists to take. A mixed Order ships a poster, emails a PDF and produces a print job; a
 * `fulfilment_status` column would force one lifecycle onto three parts that do not share one,
 * which is cheap today and unfixable once there is order history. One row here per way this
 * Order is delivered, and the Line Items it covers point at it.
 *
 * **Everything about the Strategy is copied, for ADR-0009's reason.** `strategy` is the name it
 * was wired under and the three booleans are what it answered *at Capture* — not what it would
 * answer now. A Fulfilment that asked the live Strategy would be rewritten by a Project changing
 * its config and destroyed by one removing a Plugin, which is exactly what a snapshot is for.
 * There is deliberately no foreign key to anything about Strategies: a Strategy is an object in
 * a config file, not a row.
 *
 * `updated_at` is here on a table nothing updates **yet**, and unlike `core_order`'s it is not a
 * tamper detector: fulfilling is its own spec, and when it arrives a Fulfilment is the one part
 * of an Order that is *expected* to move — dispatched, delivered, cancelled — while the Order
 * around it never does. The trigger is attached in a `--custom` migration (ADR-0037).
 */
export const fulfilment = pgTable(
  "core_fulfilment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      // An Order's Fulfilments are the Order's, exactly as its Line Items are.
      .references(() => order.id, { onDelete: "cascade" }),
    /** The Fulfilment Strategy that produced this, by the name it was wired under. */
    strategy: text("strategy").notNull(),
    /** What that Strategy answered about these lines, as at Capture. */
    requiresShipping: boolean("requires_shipping").notNull(),
    tracksInventory: boolean("tracks_inventory").notNull(),
    hasLeadTime: boolean("has_lead_time").notNull(),
    // No `metadata`, like `core_payment` and `core_reservation` beside it. ADR-0004's escape
    // hatch is for an entity somebody has something to say about, and nothing may say anything
    // about a Fulfilment yet — a column no route writes and no shape reports would be a
    // promise about a feature that has not been designed.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Reading an Order reads its Fulfilments by `order_id`, which is every view of one.
    index("core_fulfilment_order_idx").on(table.orderId),
  ],
);

export type FulfilmentRow = typeof fulfilment.$inferSelect;

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
    /**
     * The **Fulfilment** this line is part of — which of the Order's parcels, mails or print
     * jobs it belongs to (ADR-0014).
     *
     * Nullable, and it says something true: an Order placed before Fulfilment existed has none,
     * exactly as it has no Payment row. Writing one would have meant inventing a Fulfilment for
     * an Order nobody recorded one for, which is the guess ADR-0038 says a backfill must never
     * make. Every Order this version of kobai places has one on every line.
     *
     * `set null` rather than `cascade`: a Fulfilment and a Line Item both belong to the Order
     * and go with it, and deleting a Fulfilment must never take a financial record's line with
     * it.
     */
    fulfilmentId: uuid("fulfilment_id").references(() => fulfilment.id, {
      onDelete: "set null",
    }),
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
    /**
     * Tax on **this Adjustment**, in minor units, and only ever on an Order-level one.
     *
     * A delivery surcharge is ADR-0022's own example of an Adjustment belonging to no line, and
     * it is taxable in most jurisdictions — so a replaced `calculate-tax` needs somewhere to put
     * that figure. `core_order_line_item.tax` is not it: an Order-level Adjustment is on no line.
     *
     * **This is the shape chosen over an Order-level tax figure beside `core_order.total`**, and
     * the argument is what a tax Step writes and what a receipt shows (#117). A real tax engine —
     * Avalara, TaxJar, Stripe Tax — answers per taxable item with carriage among them, so tax per
     * Adjustment is what it already has in hand; a single figure on the Order makes it sum first
     * and throws the attribution away. A receipt then cannot be rendered: an invoice shows tax
     * against the thing that bore it, and a Return refunding only the delivery surcharge has to
     * know that surcharge's tax to refund it. And a `core_order.tax` would have had to mean
     * either *all* tax — duplicating the sum of the line taxes, in a second place able to
     * disagree — or *the remainder after the lines*, which is a figure nothing else in kobai
     * names. The parts are not recoverable from a total; a total is always recoverable from the
     * parts.
     *
     * **Zero on a line-level Adjustment, and the check constraint keeps it there.**
     * `calculate-tax` runs after `apply-adjustments` and taxes the *adjusted* line, so a line's
     * Adjustments are already inside `core_order_line_item.tax` — a second figure here would be
     * charged twice or dropped, and neither is discoverable from the row. If the tax spec ever
     * wants tax attributed to a single line-level Adjustment, that is a migration dropping this
     * constraint together with a decision about what a line's `total` then means.
     *
     * `default(0)` rather than ADR-0038's three migrations, and it is the ADR's own first case:
     * the value is right for future rows as well as past ones. Core charges no tax at all, so
     * zero is what every Adjustment already written truthfully carries and what every Adjustment
     * a deployment with no tax Step will write truthfully carries. It is `core_order_line_item`'s
     * `tax` column exactly, for the same reason.
     */
    tax: bigint("tax", { mode: "number" }).notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Reading an Order reads its Adjustments by `order_id`, which is every view of one.
    index("core_order_adjustment_order_idx").on(table.orderId),
    // A line's Adjustment is taxed through its line, never on its own row — see `tax` above.
    check(
      "core_order_adjustment_line_level_is_untaxed",
      sql`${table.orderLineItemId} is null or ${table.tax} = 0`,
    ),
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
    /**
     * The Cart this claim is held for, so that a second request holding it can **adopt** the
     * hold rather than take another (ADR-0070).
     *
     * There was no such column until a storefront could hold a Cart's stock before sending a
     * Shopper to their bank: `hold-reservations` ran only inside `place-order`, which claimed
     * once and consumed in the same request, so nothing ever had to find a hold again. Adopting
     * is finding one, and `provider` and `subject` cannot say which Cart asked.
     *
     * **Nullable, and that is a fact rather than a shortcut** (ADR-0038). Every Reservation
     * written from here on carries a Cart, because both callers hold for one; the rows an
     * upgrading deployment already has were written when nothing recorded it, and no backfill
     * value could say which Cart without inventing one. `null` says the Cart was never
     * recorded, which is the truth about exactly those rows — and a hold with no Cart is simply
     * one nothing will adopt.
     *
     * **`set null` rather than `cascade`**, for `order_id`'s reason turned around: the units are
     * claimed whether or not the Cart row survives, and a Reservation that vanished with its
     * Cart would leave `core_inventory.reserved` holding stock with no row left to release it
     * by. Nothing in Core deletes a Cart; this is what the column means if anything ever does.
     */
    cartId: uuid("cart_id").references(() => cart.id, { onDelete: "set null" }),
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
    // What claim-or-adopt looks a Cart's live hold up by, on every hold and every placement.
    index("core_reservation_cart_idx").on(table.cartId),
    check("core_reservation_quantity_is_positive", sql`${table.quantity} > 0`),
  ],
);

export type ReservationRow = typeof reservation.$inferSelect;
