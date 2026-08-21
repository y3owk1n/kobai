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
import {
  FULFILMENT_PENDING,
  FULFILMENT_STATES,
  type FulfilmentState,
} from "../fulfilment/lifecycle.ts";
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
    /**
     * ISO 4217, e.g. `USD`. The Store's default, and what an **unconstrained** Price is
     * denominated in (ADR-0074).
     *
     * It does not move: `PATCH /admin/store` refuses any other code (ADR-0065), and since
     * #291 that refusal stands on the narrower base ADR-0074 left it — a Price may name any
     * currency {@link storeCurrency} holds, so moving this reinterprets the unconstrained
     * ones rather than all of them. It is also always **in** the enabled set: the migration
     * that created that table put it there, and disabling it is refused.
     */
    defaultCurrency: text("default_currency").notNull(),
    /**
     * Which Region a request that names none is answered for — the fallback
     * `GET /store/variants/{id}/price?region=` falls back to (ADR-0074).
     *
     * **Nullable, and seeded at boot rather than by a migration** (`store/seed.ts`,
     * ADR-0041). A Region selects one of the Store's enabled currencies, and which currency
     * this Store prices in is not settled until *every* migration set has applied — a
     * Project's own set may write `core_store` and the reference one does exactly that. So a
     * migration seeding this would name whatever Core's placeholder happened to be, and
     * `null` is the honest value for the instant between the schema existing and the first
     * boot after it.
     *
     * **This is the Store pointing at a Region and never a Region pointing at the Store.**
     * ADR-0005's rule is about what is *referenced*: a `store_id` on another table is a
     * scoping key and this is a column on the singleton, so `store.test.ts`'s sweep is
     * untouched by it.
     */
    defaultRegionId: uuid("default_region_id").references(() => region.id, {
      // A Region the Store falls back to must not vanish under it, and the repair is a
      // control the Merchant already has: point the Store at another Region, then delete
      // this one (ADR-0059).
      onDelete: "restrict",
    }),
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
 * The currencies this Store may price in — the **vocabulary**, one row per code (ADR-0074).
 *
 * **Rows rather than a `jsonb` array on the Store**, which is the decision rather than a
 * preference: enabling a currency is the sort of thing that grows a setting — a rounding rule,
 * a display format, a Payment Provider of its own — and a setting arriving beside a blob is a
 * migration across every deployment's Store row, where beside a row it is a column.
 *
 * **The code is the key.** A currency is enabled once or not at all, so there is no identifier
 * to hold and no second row a unique index would have to refuse; everything that references one
 * references the code, which is also what a Price carries. The `char_length` check is
 * `core_store.default_currency`'s, said again about the same kind of value — what makes a code
 * a *real* ISO 4217 code is not a fact this table can hold, and a closed list of them in DDL
 * would be a table of the world that goes stale.
 *
 * **The Store's default is in here and cannot be taken out.** The migration that created this
 * table enabled it, and `PATCH /admin/store` refuses a set that leaves it out — because the
 * default is what an *unconstrained* Price is denominated in, which is the narrower base
 * ADR-0074 left ADR-0065's refusal standing on.
 *
 * There is no reference to the Store, in either direction. One deployment is one Store
 * (ADR-0005), so an enabled currency belongs to the deployment exactly as a Role does.
 */
export const storeCurrency = pgTable(
  "core_store_currency",
  {
    /** ISO 4217, upper case — `USD`, `MYR`. Written upper-cased, so the key means what it says. */
    code: text("code").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // `core_store_currency_code_…` and not `core_store_currency_is_iso4217`, which is already
    // `core_store.default_currency`'s check: Postgres scopes a constraint name to its table, but
    // kobai matches a violation **by name** (`db/errors.ts`), so two constraints sharing one
    // would be indistinguishable to any handler that ever asked about either.
    check("core_store_currency_code_is_iso4217", sql`char_length(${table.code}) = 3`),
  ],
);

export type StoreCurrencyRow = typeof storeCurrency.$inferSelect;

/**
 * A **Region** — a geography this Store sells into, and the thing a Price is asked for by
 * (ADR-0005, ADR-0074).
 *
 * **It selects a currency rather than declaring one.** The Store enumerates what may be priced
 * in; a Region names one of those, and the foreign key onto {@link storeCurrency} is that
 * sentence in the database rather than in a function somebody has to remember to call.
 * Region-only ownership was rejected in ADR-0074 because it makes a currency unusable until
 * somebody defines a geography, which is wrong for a single-country Store that wants two
 * currencies.
 *
 * **A name, a currency, and the shipping methods that deliver into it.** {@link shippingMethod}
 * is the half spec 5 owed and #321 built; tax treatment is spec 7 and hangs off this row when it
 * arrives. `metadata` is ADR-0004's escape hatch, here for the reason every principal entity
 * carries one. What it is emphatically **not** is a tenant: ADR-0005 says a Region is variation
 * *within* one Store, so nothing scopes by one and `store.test.ts`'s question is asked of this
 * table too — `region.test.ts` names what references it, so the day one becomes a scoping key
 * the build goes red rather than the retrofit going unnoticed. Every column pointing here is a
 * *constraint on a row* rather than a scope: a Price naming a Region still applies everywhere
 * when it names none, and a shipping method naming one **is** the fact that this is what
 * delivery costs there.
 */
export const region = pgTable(
  "core_region",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What the Merchant calls it — `Malaysia`, `Eurozone`. Not unique; two are two Regions. */
    name: text("name").notNull(),
    /**
     * The code this Region prices in, which must be one the Store has enabled.
     *
     * The reference is `restrict` rather than `cascade`: disabling a currency a Region selects
     * is refused, naming the Regions, because the alternatives are deleting somebody's Region
     * or leaving one denominated in a currency the Store does not price in (ADR-0059).
     */
    currency: text("currency")
      .notNull()
      .references(() => storeCurrency.code, { onDelete: "restrict" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // What `GET /admin/regions` pages along — see `core_api_key`'s for why both columns.
    index("core_region_created_at_id_idx").on(table.createdAt, table.id),
  ],
);

export type RegionRow = typeof region.$inferSelect;

/**
 * A **shipping method** — a named way of delivering into one Region, at a flat rate (#321,
 * ADR-0005, ADR-0074).
 *
 * The smallest honest implementation of shipping, and the place ADR-0005 already puts it: a
 * Region is where geography is modelled, so what it costs to deliver there hangs off the Region
 * rather than off the Store or off a Variant. `core_region`'s own comment has said so since
 * #291 — *"shipping methods are spec 5, and both hang off this row when they arrive"*.
 *
 * **The rate is denominated in the Region's currency and carries no currency column**, which is
 * the one thing to hold when this table grows. A Region selects exactly one currency
 * (ADR-0074), a Cart in that Region is stamped in it, and kobai converts nothing — so a code
 * here would be a second answer to what this method costs in, able to disagree with the Region
 * it belongs to. Moving a Region onto another currency therefore reinterprets its rates rather
 * than converting them, which is the same trade `core_price` makes from the other side and is
 * why the Admin says so at the currency picker.
 *
 * **`region_id` is not a scoping key**, and this is the third row-level constraint on this
 * schema that has to say so out loud — `core_price.region_id` and `core_cart.region_id` are the
 * others. Nothing is *narrowed* by a Region: this row **is** a fact about one geography, the way
 * a Price constrained to a Region is a fact about one Price, and `region.test.ts` names the key
 * so the day a `region_id` appears somewhere it would be a scope the build goes red.
 *
 * `cascade`, unlike everything else pointing at a Region: a delivery rate for a geography this
 * Store no longer sells into is a row with no remaining meaning, which is exactly
 * `core_price.region_id`'s judgement and not `core_address.region_id`'s — deleting a Region does
 * not move a street, but it does retire the price of getting there.
 */
export const shippingMethod = pgTable(
  "core_shipping_method",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    regionId: uuid("region_id")
      .notNull()
      .references(() => region.id, { onDelete: "cascade" }),
    /** What the Merchant calls it — `Standard`, `Next day`. Not unique; two are two methods. */
    name: text("name").notNull(),
    /**
     * The flat rate, in minor units of the Region's currency — 500 is MYR 5.00.
     *
     * **Never negative**, unlike an Adjustment's signed amount: a delivery that paid the Shopper
     * is not a shipping method, it is a discount, and ADR-0022 already has a shape for one. Zero
     * is free delivery and is the point of allowing it.
     */
    amount: bigint("amount", { mode: "number" }).notNull(),
    /**
     * Where this one sits in the list the Merchant declared, within its Region.
     *
     * Stored for `core_order_adjustment.position`'s reason one noun along: the whole list is
     * written in one request, so `created_at` cannot tell one from another after a reorder, and
     * a storefront offering a Shopper a choice renders them in the order a Merchant put them in.
     */
    position: bigint("position", { mode: "number" }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Every read of these is by Region — the Region's own payload, the options a Cart is
    // offered, and the rate `select-shipping` charges.
    index("core_shipping_method_region_idx").on(table.regionId),
    check("core_shipping_method_amount_is_not_negative", sql`${table.amount} >= 0`),
  ],
);

export type ShippingMethodRow = typeof shippingMethod.$inferSelect;

/**
 * A **Channel** — a route to market this Store sells through (ADR-0005).
 *
 * A name and nothing else, deliberately. ADR-0005 says a Channel is a sales channel and
 * **not** a tenant boundary — the mistake Vendure's overloaded `Channel` is the known example
 * of — so this table carries no scope, no ownership and no reference to anything. What varies
 * per Channel is a *Price*, through `core_price.channel_id` (#292).
 *
 * **Which Channel a request is in is decided by the API key** and never threaded through a
 * request (ADR-0020): `core_api_key.channel_id` is the binding, so a storefront cannot claim to
 * be in a Channel it was not issued a credential for. That and `core_price.channel_id` are the
 * two foreign keys onto this table, and `channel.test.ts` asserts they are the only ones —
 * neither is a scoping key, which is the thing ADR-0005 says a Channel must never become.
 */
export const channel = pgTable(
  "core_channel",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What the Merchant calls it — `Web`, `Marketplace`. Not unique; two are two Channels. */
    name: text("name").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // What `GET /admin/channels` pages along — see `core_api_key`'s for why both columns.
    index("core_channel_created_at_id_idx").on(table.createdAt, table.id),
  ],
);

export type ChannelRow = typeof channel.$inferSelect;

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
    /**
     * Which Channel a request presenting this key is in, or `null` for unconstrained
     * (ADR-0005, ADR-0020).
     *
     * **Nullable, and `null` is the ordinary value.** Every key that exists today was minted
     * before Channels did, and every key minted without one still is: unconstrained means
     * *this credential is in no particular Channel*, which is the whole of what a deployment
     * that has defined none can say. So this column needs none of ADR-0038's dance — a
     * nullable column and a foreign key on one can refuse no row that is already there.
     *
     * **`set null` rather than `restrict`.** Revocation is a column rather than a delete, so a
     * revoked key keeps its row forever — a `restrict` here would make a Channel any key had
     * ever named permanently undeletable, which is a refusal with no repair a Merchant could
     * carry out. Deleting a Channel therefore returns its keys to exactly the state every key
     * was in before the Channel existed, which is a widening a Merchant asked for by deleting
     * the route to market.
     */
    channelId: uuid("channel_id").references(() => channel.id, { onDelete: "set null" }),
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
 * **What it does not say is that two Variants answer differently**, and there is no index that
 * could: the combination is one row per option, so the fact is spread over as many rows as the
 * Product has options and no per-row constraint can see it. `catalog/options.ts` holds that rule
 * instead — `variant-combination-taken`, at every route that writes a Variant and at the
 * Product's own option correction — under `lockProductOptions`, which is what makes reading the
 * siblings and writing against them one operation (#277, ADR-0018).
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
 * **The first two constraint columns arrived in #292**, which is the prediction above being
 * spent rather than a change of shape: `region_id` and `channel_id` are nullable, `null` means
 * *applies to all*, and resolving a Price is still best match inside a Workflow rather than a
 * column read (`pricing/resolve-price.ts`). Quantity breaks and customer groups are the same
 * shape again and are not modelled.
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
    /**
     * ISO 4217, e.g. `USD`. Any currency the Store has enabled (ADR-0074), and the Store's
     * default for a Price that named none — which is what every Price written before #292 is.
     */
    currency: text("currency").notNull(),
    /**
     * The Region this Price applies to, or `null` for **every** Region (ADR-0008, ADR-0074).
     *
     * **Nullable, and `null` is the ordinary value**, exactly as `core_api_key.channel_id` is:
     * every Price written before #292 applies to all of them, which is what makes this column
     * ADR-0038's first case rather than its three-step dance — a nullable column and a foreign
     * key on one can refuse no row that is already there.
     *
     * **`cascade` rather than `restrict`, and it is the one place this table departs from
     * ADR-0059's refuse-rather-than-cascade** — recorded in that ADR, under the heading naming
     * this column. The test ADR-0059 actually applies is whether the repair is a control the
     * Merchant has, and #292 answered that with *nothing lists Prices by Region*: a `restrict`
     * would have refused the deletion and pointed at rows a Merchant could only find by opening
     * every Variant.
     *
     * **`GET /admin/prices?region=` lists them now (#310), and the cascade is kept on a
     * different argument.** The repair a `restrict` would demand *is* the deletion this
     * performs — a Price constrained to a Region that no longer exists can never apply to
     * anything again, so there is nothing else to do with one — and it would demand it one row
     * at a time, because no route deletes Prices in bulk. What the list changes is that the
     * cost is legible **before** the act rather than named by a refusal after it, which is the
     * better half of what refusing would have bought. `set null` is still the worse third
     * answer — a Price entered for Malaysia would silently become the fallback for everywhere.
     */
    regionId: uuid("region_id").references(() => region.id, { onDelete: "cascade" }),
    /** The Channel this Price applies to, or `null` for **every** Channel. See `region_id`. */
    channelId: uuid("channel_id").references(() => channel.id, { onDelete: "cascade" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Resolution reads every Price of one Variant and picks among them, so this index is
    // what makes "a row, not a column" cost a join rather than a scan.
    index("core_price_variant_idx").on(table.variantId),
    // What `GET /admin/prices` pages along (#310) — see `core_api_key`'s for why both columns,
    // and `db/schema.test.ts` for the sweep that fails a paged list without one.
    index("core_price_created_at_id_idx").on(table.createdAt, table.id),
    // Not for a read — resolution asks by Variant and chooses in TypeScript — but for the
    // `cascade` above: deleting a Region asks this table which rows name it, and without an
    // index that question is a scan of every Price in the Store.
    index("core_price_region_idx").on(table.regionId),
    index("core_price_channel_idx").on(table.channelId),
    // No unique constraint on (variant, currency, region, channel): several Prices matching one
    // request is the representable shape ADR-0008 asks for, and best match is what tells them
    // apart — with an ordering ending in `id`, so a tie resolves the same way twice (#132).
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
 * A **Collection** — a Merchant's grouping of Products, so a storefront has navigation
 * (#256, stories 13 and 18).
 *
 * **Core's table and not the content Plugin's**, which is ADR-0074's neighbour decision taken
 * rather than deferred: the *grouping* is a catalog relationship — it decides which Products a
 * storefront lists together, and it is what `GET /admin/products` and `GET /store/products`
 * narrow by — while the **page** that renders one, its copy and its layout, is content and
 * belongs to the Plugin. Putting the grouping in a Plugin would have made `?collection=` a
 * filter Core could not implement.
 *
 * **No handle, and that is a decision rather than an omission.** `core_product.handle` exists
 * because `GET /store/products/{idOrHandle}` resolves one, and nothing resolves a Collection by
 * name: a storefront browses one through `?collection=`, by the identifier the Product it is
 * already holding reports. The address a Collection is *published* at is a property of the page
 * that renders it, which is #216's, and a second unique string on this table would be ADR-0038's
 * whole dance taken now for a route that does not exist yet. It is additive under ADR-0060 the
 * day one does.
 *
 * **The title is not unique either**, unlike `core_role.name`. A Role's name is how a Merchant is
 * *created against* one, so two of them could not be told apart; a Collection is addressed by its
 * identifier everywhere, so two called `Summer` are two groupings a Merchant may perfectly well
 * have meant — and a constraint is the one place a relaxation cannot reach the rows already
 * written.
 *
 * There is no position, no parent and no rule that fills one: nesting, ordering and automatic
 * membership are all named out of scope by #209, and a flat, manually-managed grouping is what
 * story 14 asks for.
 */
export const collection = pgTable(
  "core_collection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What the Merchant calls it — `Summer`, `Under 20`. Not unique; see above. */
    title: text("title").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // What `GET /admin/collections` pages along — see `core_api_key`'s for why both columns.
    index("core_collection_created_at_id_idx").on(table.createdAt, table.id),
  ],
);

export type CollectionRow = typeof collection.$inferSelect;

/**
 * Which Products are in which Collections — a **join table and never a column** (story 14).
 *
 * A `collection_id` on `core_product` would make grouping the hierarchy story 14 exists to
 * refuse: a poster belonging in Summer *and* in Under 20 would have to be two Products, or one
 * of the two groupings would have to lose. So membership is a row, a Product has as many as
 * somebody wrote, and a Collection holds as many Products as were put in it.
 *
 * **Both foreign keys cascade, and neither cascade reaches a principal row** — which is the
 * whole of story 17, and the property #256 asked to be asserted directly rather than left for
 * the DDL to imply. Deleting a Collection deletes **these rows** and stops: every Product it
 * held is still in the catalog, still published, still sellable, and merely ungrouped. The
 * mirror image holds for a deleted Product, which takes its memberships and leaves every
 * Collection standing. Organising is never destructive in either direction, and
 * `catalog/collection.test.ts` watches both.
 *
 * **`cascade` here is the opposite judgement from `core_product_media.media_id`'s `restrict`,
 * for the opposite reason.** A Media a Product is showing must not vanish out from under it
 * (ADR-0082), so that one is refused-while-attached by construction. A Collection is a *label*,
 * and removing a label from a Product is exactly what deleting it should do — refusing would
 * mean a Merchant had to empty a Collection before they could remove it, which is tidying up in
 * order to delete a name.
 *
 * **There is no `position`**, unlike {@link productMedia} and {@link productOption}. The order
 * images are shown in is a Merchant's decision and story 9 says so; the order of a set is not a
 * fact this table has, because ordering rules are named out of scope by #209. What a Product
 * reports is therefore its Collections **by title**, which is the only column of one a Merchant
 * would recognise, with `id` breaking the tie because titles are not unique.
 *
 * **The unique index is what makes a Product a member once.** The same pair twice is the same
 * fact twice, and every write here replaces a Product's whole set — delete then insert — so
 * nothing on its way in can collide with a row on its way out.
 */
export const productCollection = pgTable(
  "core_product_collection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      // A deleted Product takes its memberships with it, and no Collection with them.
      .references(() => product.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      // A deleted Collection takes its memberships with it, and no Product with them — story 17,
      // stated in the database rather than in a function somebody has to remember to call.
      .references(() => collection.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("core_product_collection_product_collection_idx").on(
      table.productId,
      table.collectionId,
    ),
    // How both Product lists narrow by `?collection=`: every membership of one Collection.
    index("core_product_collection_collection_idx").on(table.collectionId),
  ],
);

export type ProductCollectionRow = typeof productCollection.$inferSelect;

/**
 * An **Address** — where something goes, and nothing else (ADR-0072).
 *
 * **Core's own entity, and validating one is not Core's.** ADR-0015 puts Shopper-supplied input
 * on the Project's side, and the letter of that would put a delivery address there too; ADR-0072
 * is where following the letter was argued down. The test it draws is whether the thing is an
 * input to *Core's own arithmetic*: a printing customer's uploaded artwork means nothing to Core
 * and no two businesses want the same validation of it, where shipping, tax and Fulfilment are
 * all computed **from** an address. So the entity is here and the judgement is not — address
 * formats differ by country to a degree no library settles, and refusing a badly-formed address
 * is a Project's decision.
 *
 * **Four columns, and each of them is structural.** `country` is a code, `lines` is whatever a
 * Shopper wrote and in the order they wrote it, `postal_code` is a string this table has no
 * opinion about, and `region_id` says which of the Store's Regions it falls in. There is no
 * `city`, no `state`, no recipient and no telephone number: an address that decomposed into
 * named parts would be kobai holding an opinion about a country's format, which is the one
 * thing ADR-0072 rules out.
 *
 * **No `metadata`, like `core_fulfilment` and `core_payment` beside it.** ADR-0004's escape
 * hatch is for an entity somebody has something to say about, and nothing may say anything about
 * an Address yet — a delivery note belongs on the Cart or on the Line Item, where a Project's
 * Step already reads one.
 *
 * **Nothing about an Order points here** (ADR-0009). Capture copies the whole of it into
 * `core_order_address`, so an Address a Shopper corrects a year later cannot rewrite where a
 * past parcel went — which is why the sweep in `cart/an-address-on-a-cart.test.ts` expects
 * exactly one foreign key onto this table, the Cart's.
 */
export const address = pgTable(
  "core_address",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * ISO 3166-1 alpha-2 — `MY`, `SG`, `GB`.
     *
     * **A length check and no table of countries**, which is exactly `core_store_currency`'s
     * bargain one noun along: what makes a code a *real* country is not a fact this table can
     * hold, and the length is. A code is the one field here Core's own arithmetic will read —
     * shipping and tax both key off it — so free text would have been an address kobai could
     * model nothing from, where a country's own *format* rules remain refused by nothing.
     */
    country: text("country").notNull(),
    /**
     * The address itself, in the order it should be read — `["12 Jalan Ampang", "Kuala
     * Lumpur"]`.
     *
     * **A list rather than named parts, and that is the decision.** A `city` and a `state`
     * column would be kobai asserting that every country's addresses decompose that way, which
     * is the claim ADR-0072 says no library settles. At least one line, in DDL: an address with
     * none is not an address, which is a shape rather than a format rule.
     */
    lines: text("lines").array().notNull(),
    /**
     * Nullable, and that is a fact rather than a shortcut.
     *
     * Several countries have no postal code at all, so requiring one would be exactly the
     * country-specific format rule ADR-0072 keeps out of Core. An empty string is refused at the
     * route for the reason every other optional string here is: it would say a Shopper had
     * written one.
     */
    postalCode: text("postal_code"),
    /**
     * Which of the Store's Regions this Address falls in, or `null` for one that names none.
     *
     * **`set null`, and it is the third answer this schema gives to the same question.**
     * `core_cart.region_id` is `set null` because no Merchant can empty a Shopper's Cart, and
     * `core_price.region_id` cascades because a Price constrained to a Region that no longer
     * exists can never apply to anything again. Neither transfers here for free, and ADR-0059's
     * actual test — *is the repair a control the Merchant has* — is what decides it:
     *
     * - **`restrict` fails that test.** The rows a refusal would name are Shoppers' Carts.
     *   Nothing a Merchant can do empties one, so a Region would be undeletable for as long as
     *   anybody was holding a basket addressed into it.
     * - **`cascade` destroys something real.** A Price constrained to a deleted Region is a row
     *   with no remaining meaning; an Address is not — deleting a Region does not move the
     *   street, and the country, the lines and the postal code are still exactly where the
     *   parcel goes. Cascading would throw away a Shopper's destination to tidy up a
     *   Merchant's geography.
     * - **`set null` leaves the destination whole and drops only the grouping**, which is the
     *   one part of it that was kobai's rather than the Shopper's. The Cart still reads, still
     *   quotes and still places, and the repair is the one a storefront already has: send the
     *   address again naming another Region.
     *
     * **The Order's snapshot survives all three regardless**, because it is a copy in
     * `core_order_address` rather than a reference to this row.
     */
    regionId: uuid("region_id").references(() => region.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Deleting a Region asks this table which rows name it, exactly as it asks `core_price` —
    // and without an index that question is a scan of every Address in the Store.
    index("core_address_region_idx").on(table.regionId),
    // `core_price.currency`'s check, said about the other standard: what makes a code a real
    // ISO 3166-1 code is not a fact this table can hold, and the length is.
    check("core_address_country_is_iso3166", sql`char_length(${table.country}) = 2`),
    // An address with no lines is not an address. `cardinality` rather than `array_length`,
    // which answers `null` for an empty array and so would let one through.
    check("core_address_has_a_line", sql`cardinality(${table.lines}) > 0`),
  ],
);

export type AddressRow = typeof address.$inferSelect;

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
    /**
     * The one currency this Cart is denominated in — **stamped, never read through the Region**
     * (#293, ADR-0074).
     *
     * It is a copy of the currency the Cart's Region selected at the moment that Region was
     * set, and it is what every line of this Cart is priced in. That duplication is the
     * decision: a Merchant may move a Region onto another currency
     * (`PATCH /admin/regions/{id}`), and a Cart whose currency was *read through* its Region
     * would be repriced by that — silently, in a different currency, possibly while a Shopper
     * is at their bank paying the old figure. So the Region says **where** this Cart is being
     * bought and this column says **what in**, and neither is derivable from the other once
     * time has passed.
     *
     * **Not a foreign key onto {@link storeCurrency}, unlike a Region's.** A Region *selects*
     * from the enabled set and is refused a code that is not in it; a Cart holds a stamp taken
     * when it was created, and a Store that disabled a currency afterwards must not be refused
     * at the constraint for a Cart somebody is still holding — `currency-in-use` names the
     * Regions and is a refusal a Merchant can act on, where a foreign key here would be a 500
     * naming a Shopper's Cart. `core_order.currency` is the same kind of stamp for the same
     * reason.
     */
    currency: text("currency").notNull(),
    /**
     * Where this Cart is being bought — the Region its lines are priced in (#293, ADR-0074).
     *
     * A Cart created without one takes the Store's default, so a single-market storefront
     * never mentions a Region; `PATCH /store/carts/{id}` moves one, in place, keeping the Cart
     * and every line on it.
     *
     * **Nullable, and that is a fact rather than a shortcut** (ADR-0038). The Store's default
     * Region is seeded at **boot** rather than by a migration (`store/seed.ts`), so at the
     * instant this column arrives there may be no Region in the database at all — there is no
     * value a backfill could write, and `null` says truthfully that this Cart was started
     * before kobai recorded one. A Cart with none is priced for the Store's default Region, in
     * its own `currency`, which is exactly what every such Cart was priced for before this
     * column existed.
     *
     * **`set null` rather than `restrict` or `cascade`.** Deleting a Region refuses only while
     * the Store falls back to it — ADR-0059's test is whether the repair is a control the
     * Merchant has, and no Merchant can empty a Shopper's Cart, so `restrict` would make a
     * Region undeletable for as long as somebody was holding one. `cascade` would delete the
     * Cart, which is somebody's basket. So a Region that goes takes no Cart with it and leaves
     * none unreadable: the row survives, `GET` still answers, and the Cart falls back to the
     * Store's default Region.
     *
     * **What that costs is worth stating exactly.** A Cart stamped in the Store's default
     * currency falls back exactly as one started before Regions did. A Cart stamped in
     * *another* currency does not: `core_price.region_id` cascades, so the Prices constrained
     * to the deleted Region went with it, and the default Region prices in something else —
     * kobai converts nothing, so that Cart quotes and places `price-not-set` until it is moved.
     * **The repair is the switch itself**, and it is available: a deleted Region denominates
     * nothing against the Cart, so moving it to a Region that prices in a currency it has
     * Prices in re-stamps it. That is ADR-0059's rule met rather than dodged — a refusal with a
     * control behind it — and it is the same trade `variant-unavailable` makes on a line whose
     * Product left the storefront.
     */
    regionId: uuid("region_id").references(() => region.id, { onDelete: "set null" }),
    /**
     * Where what is in this Cart is to be delivered, or `null` for a Cart nobody has said
     * (#319, ADR-0072).
     *
     * **Nullable, and nothing here makes it otherwise.** A Cart with no Address reads, quotes
     * and places exactly as it did before this column existed — which is also why it needs none
     * of ADR-0038's three steps. Whether *shipping* requires one is a decision about shipping,
     * and it is not this column's.
     *
     * **One Address per Cart, replaced in place.** Setting one again writes the row that is
     * already here rather than leaving a second behind, so nothing accumulates rows no route
     * can reach; `address: null` deletes it and leaves this column `null`. The reference is
     * `set null` as the backstop for a row deleted some other way (ADR-0004's unmediated
     * writer), which is a Cart with no Address rather than a Cart nothing can read.
     *
     * **An Order does not read through this**, and that is ADR-0009: Capture copies the Address
     * into `core_order_address`, so a Shopper correcting their details afterwards — or removing
     * the Address from the Cart entirely — cannot rewrite where a past parcel went.
     */
    addressId: uuid("address_id").references(() => address.id, { onDelete: "set null" }),
    /**
     * The shipping method the Shopper chose, or `null` for a Cart nobody has chosen one for
     * (#321).
     *
     * **Nullable, and it is the honest value in three different situations rather than one.** A
     * Cart of downloads has nothing to ship; a Cart in a Region this Store has defined no rates
     * for has nothing to choose from; and a Cart whose Shopper has not reached the delivery step
     * has not chosen yet. Requiring one would make every Store that does not price delivery
     * unable to sell a physical thing at all, which is the state kobai has been in until now —
     * so `select-shipping` charges what was chosen and charges nothing where nothing was.
     *
     * It also needs none of ADR-0038's three steps for the ordinary reason: a nullable column is
     * safe to add at any size, and a foreign key on one can refuse no row already there, since
     * every one of them holds `null` (`core_reservation.cart_id` is the precedent).
     *
     * **`set null`, and the two ways it fires are both right.** Deleting a shipping method — or
     * the Region that carries it, which cascades — leaves the Cart whole and the Shopper choosing
     * again, where `restrict` would make a Merchant's rate undeletable while a stranger held a
     * basket and `cascade` would delete somebody's basket to tidy up a rate. **Moving a Cart to
     * another Region clears it too**, in `cart/write.ts` rather than here: a method belongs to
     * one Region, so the one chosen in the old market is not on offer in the new one.
     *
     * **An Order does not read through this.** What was charged is an Order-level Adjustment
     * written at Capture (ADR-0022), so deleting the method afterwards cannot rewrite what a
     * Shopper paid — ADR-0009's argument, in the shape the Address already has one door along.
     */
    shippingMethodId: uuid("shipping_method_id").references(() => shippingMethod.id, {
      onDelete: "set null",
    }),
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
    // `core_price.currency`'s check, said again about the same kind of value: what makes a code
    // a *real* ISO 4217 code is not a fact this table can hold, and the length is. It arrives in
    // the third step of the widening, onto rows the backfill has already made satisfy it
    // (ADR-0038).
    check("core_cart_currency_is_iso4217", sql`char_length(${table.currency}) = 3`),
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
 * **This is the one Core table that is expected to move**, and unlike `core_order`'s its
 * `updated_at` is not a tamper detector: a Fulfilment is dispatched, delivered or cancelled
 * while the Order around it never changes at all (#320). The trigger is attached in a `--custom`
 * migration (ADR-0037), and it advances on every transition below.
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
    /**
     * **Where this part of the Order has got to** — `pending`, `dispatched`, `delivered` or
     * `cancelled`, and never a column on `core_order` (ADR-0014, #320).
     *
     * That absence is the decision this column exists to keep: a mixed Order ships a poster,
     * emails a PDF and produces a print job on three timelines, and one status on the Order
     * would force a single lifecycle onto all three — cheap today and unfixable once there is
     * order history. `fulfilment/lifecycle.ts` is the one place the states and the legal moves
     * between them are written down, and every route reads them from there.
     *
     * **`DEFAULT 'pending'` rather than ADR-0038's three migrations**, because the value is
     * right for the rows that were already here *and* for every row after — which is exactly
     * when a default is a default rather than a backfill wearing one. Nothing could move a
     * Fulfilment before this column existed, so `pending` is the fact that was never recorded
     * rather than a guess at one; and it is where Capture leaves every Fulfilment written from
     * here on. One statement, and on Postgres 11 and later no table rewrite.
     *
     * **The `check` is `core_product.status`'s judgement, not `fulfilment_strategy`'s** two
     * fields up. A Strategy is named by whatever key a deployment wired and is deliberately
     * open; these four words are Core's own and nothing outside Core can invent a fifth, so a
     * row holding one is a bug rather than a Merchant's choice. It arrives at rows that already
     * satisfy it, because the statement adding the column gives every one of them `pending`.
     */
    state: text("state").$type<FulfilmentState>().notNull().default(FULFILMENT_PENDING),
    /**
     * What the Merchant wrote down when they dispatched this, or `null`.
     *
     * **An opaque string.** kobai parses nothing out of it and models no carrier: a tracking
     * reference is a handle to quote somewhere else, exactly as `core_payment.reference` is,
     * and delivery estimates and carrier modelling are out of scope in #211.
     *
     * Nullable, and it stays nullable: a dispatch may record none — a PDF emailed to a Shopper
     * has nothing to track — so requiring one would make the field a lie for every Store that
     * sells a download. It is written by a dispatch and by nothing else.
     */
    trackingReference: text("tracking_reference"),
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
    // Written from `fulfilment/lifecycle.ts`'s one list rather than retyped, and `sql.raw` for
    // `core_product_status_is_known`'s reason: a `${value}` in a Drizzle template is a bound
    // parameter, which is not a constraint anything could enforce.
    check(
      "core_fulfilment_state_is_known",
      sql`${table.state} in (${sql.raw(FULFILMENT_STATES.map((state) => `'${state}'`).join(", "))})`,
    ),
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
 * Where an Order went — a **snapshot**, taken at Capture and never read through anything
 * (#319, ADR-0009, ADR-0072).
 *
 * **A table of copies rather than a reference to `core_address`, and that is the whole
 * decision.** An Order that pointed at the Address row its Cart carried would be rewritten by a
 * Shopper correcting their details a year later and emptied by one clearing the Address off the
 * Cart — the same failure ADR-0009 refuses for a Line Item's title and price, one noun along.
 * So `country`, `lines` and `postal_code` are columns here, and there is **no `address_id`**:
 * not nullable, not `set null`, absent. Nothing under this row can be edited or deleted,
 * because there is nothing under it.
 *
 * **`region_id` is the one exception and it is navigation only**, exactly as
 * `core_order_line_item.variant_id` is: `set null`, nullable, and never read for display or
 * arithmetic. `region_name` beside it is the snapshot, so deleting the Region an Address named
 * leaves this record saying where the parcel went and losing only the trail back.
 *
 * **Its own table rather than columns on `core_order`**, for two reasons that point the same
 * way. `lines` is a repeated group, so it would be an array column on the Order whatever
 * happened; and an Order has an Address or has none, so columns there would be four more
 * nullables whose `null` meant two different things. One row or no row says it once.
 *
 * `updated_at` is here on a row nothing updates, and it is `core_order`'s tamper detector rather
 * than `core_fulfilment`'s expectation of movement: this record should equal `created_at`
 * forever, and a value that has moved is evidence somebody wrote to a snapshot (ADR-0037).
 */
export const orderAddress = pgTable(
  "core_order_address",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      // An Order's destination is the Order's, exactly as its Line Items are.
      .references(() => order.id, { onDelete: "cascade" }),
    /** ISO 3166-1 alpha-2 as at Capture. See `core_address.country`. */
    country: text("country").notNull(),
    /** The address itself, in the order it should be read, as at Capture. */
    lines: text("lines").array().notNull(),
    postalCode: text("postal_code"),
    /**
     * The Region the Address named — **for navigation only**, and `null` once it is deleted.
     *
     * `set null` rather than `restrict` or `cascade`, and both alternatives are the ones
     * ADR-0009 already refuses on a Line Item: a reference that could hold a Merchant's delete
     * hostage, or take a financial record with it, is the Order depending on live data in a new
     * place. {@link orderAddress.regionName} is what a person reads.
     */
    regionId: uuid("region_id").references(() => region.id, { onDelete: "set null" }),
    /** What that Region was called at Capture. `null` where the Address named none. */
    regionName: text("region_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // **One destination per Order, in DDL.** Reading an Order reads this by `order_id`, and a
    // second row would make "where did it go" a question with two answers.
    uniqueIndex("core_order_address_order_idx").on(table.orderId),
    // For the `set null` above: deleting a Region asks this table which rows name it.
    index("core_order_address_region_idx").on(table.regionId),
    check(
      "core_order_address_country_is_iso3166",
      sql`char_length(${table.country}) = 2`,
    ),
    check("core_order_address_has_a_line", sql`cardinality(${table.lines}) > 0`),
  ],
);

export type OrderAddressRow = typeof orderAddress.$inferSelect;

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
