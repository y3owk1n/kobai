import { asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Database, Queryable, Transaction } from "../db/client.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
import { collection, product, productCollection } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { isJsonObject, trimmed } from "../input.ts";
import {
  type Changes,
  changesFrom,
  changesNothing,
  mustBeText,
  type NotUsable,
  notUsable,
  openData,
  text,
} from "../patch.ts";

/**
 * Collections: making one, reading them, renaming one, removing one — and which Products are in
 * which (#256, stories 13, 14, 16, 17 and 18).
 *
 * `CONTEXT.md` has named the term since the domain model was first written down and no table
 * implemented it, so a kobai catalog was a flat list: a Merchant could sell a hundred things and
 * a storefront had no way to offer anything but all of them.
 *
 * **A Collection is Core's and not the content Plugin's**, which is ADR-0074's neighbour
 * decision taken rather than deferred to #216. The grouping is a **catalog relationship** — it
 * is what both Product lists narrow by — while the *page* that renders a Collection, its copy
 * and its layout are content. Splitting it the other way would have left `?collection=` a filter
 * Core could not implement without reading a Plugin's tables, which ADR-0004 forbids in both
 * directions.
 *
 * Three things here are decisions rather than implementation:
 *
 * **Deleting a Collection ungroups its Products and deletes none of them** (story 17). That is
 * `core_product_collection.collection_id`'s `on delete cascade`, which reaches the join row and
 * stops — and it is the opposite judgement from `core_product_media.media_id`'s `restrict`, for
 * the opposite reason: a picture a Product is showing must not vanish out from under it
 * (ADR-0082), while a Collection is a label and removing a label is exactly what deleting one
 * should do. Refusing instead would mean emptying a Collection before it could be removed, which
 * is tidying up in order to delete a name. `collection.test.ts` asserts the Products directly
 * rather than trusting the DDL to imply them.
 *
 * **Membership is a whole set, written at `POST /admin/products` and at
 * `PATCH /admin/products/{id}` and nowhere else**, and it is `media`'s bargain one noun along —
 * {@link parseCollectionMemberships} is where the half of that argument which *does* carry is
 * written out, since a set has no order for the other half to be about, and where the create's
 * arrival (#280) is argued.
 *
 * **`?collection=` is one predicate, and {@link inCollection} is it.** Both Product lists narrow
 * by the same expression, applied in the same statement as the page, so a filtered page that
 * comes back short is still a page and `nextCursor` still means what it means (ADR-0064). What
 * differs between the two surfaces is what else is in that `where` — the store list's `published`
 * is in the route (`catalog/store-read.ts`) and this filter is deliberately no way round it.
 */

/** The one word both the Collection routes and a membership list are refused with. */
export const COLLECTION_NOT_FOUND = "collection-not-found";

/** A Collection as the admin surface reports it — the whole row, minus what nobody reads. */
export type Collection = {
  readonly id: string;
  readonly title: string;
  readonly metadata: Record<string, unknown>;
};

export type CollectionCreation =
  | { readonly ok: true; readonly collection: Collection }
  | { readonly ok: false; readonly reason: "invalid"; readonly detail: string };

/**
 * Correcting a Collection refuses two ways, and there is deliberately no `collection-title-taken`
 * beside them.
 *
 * A title is what a Collection is *called* rather than what identifies it — everything addresses
 * one by its identifier — so two called `Summer` are two groupings a Merchant may well have
 * meant. `core_role.name` is the contrast and the reason it is unique is exactly the one absent
 * here: a Merchant is created *against a Role by name*.
 */
export type CollectionUpdate =
  | { readonly ok: true; readonly collection: Collection }
  | {
      readonly ok: false;
      readonly reason: "invalid" | typeof COLLECTION_NOT_FOUND;
      readonly detail: string;
    };

/**
 * Deleting a Collection refuses exactly one way: there is no such Collection.
 *
 * **Nothing here is `role-in-use`'s shape, and that is story 17.** A Role Merchants hold is
 * refused because deleting it would leave them holding nothing at all (ADR-0059); a Collection
 * Products are in is deleted, and the Products are merely no longer in it. Organising is never
 * destructive.
 */
export type CollectionDeletion =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: typeof COLLECTION_NOT_FOUND;
      readonly detail: string;
    };

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type CreateCollectionInput = {
  readonly title?: unknown;
  readonly metadata?: unknown;
};

export type UpdateCollectionInput = CreateCollectionInput;

/** The columns a body names, of which a `PATCH` names some and a create names all it means to. */
type CollectionColumns = {
  title: string;
  metadata: Record<string, unknown>;
};

/** Said once, because two paths reach it: a create naming no title, and either path given a blank. */
const TITLE_MUST_BE_A_TITLE = mustBeText("title");

/** The columns a Collection is reported by. Named once, because five queries answer with them. */
const REPORTED = {
  id: collection.id,
  title: collection.title,
  metadata: collection.metadata,
} as const;

export async function createCollection(
  db: Database,
  input: CreateCollectionInput,
): Promise<CollectionCreation> {
  const usable = readCollectionInput(input);
  if (!usable.ok) return usable;

  const { title, metadata = {} } = usable.changes;
  if (title === undefined) return notUsable(TITLE_MUST_BE_A_TITLE);

  const [created] = await db
    .insert(collection)
    .values({ title, metadata })
    .returning(REPORTED);
  // Unreachable — an `insert … returning` of one row answers with one row — and typed rather
  // than asserted away.
  if (!created) throw new Error("unreachable: creating a Collection answered no row");
  return { ok: true, collection: created };
}

/**
 * A page of Collections, newest first — the same ordering and the same cursor every other list
 * on this surface uses (ADR-0064), ending in `id` so it cannot tie.
 */
export async function listCollections(
  db: Database,
  page: PageRequest,
): Promise<Page<Collection>> {
  const rows = await db
    .select({ ...REPORTED, cursorAt: cursorAt(collection.createdAt) })
    .from(collection)
    .where(rowsAfter(page, collection.createdAt, collection.id))
    .orderBy(desc(collection.createdAt), desc(collection.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  // Field by field rather than by spread, so the column the cursor is cut from cannot reach a
  // response by being forgotten about.
  return {
    items: found.map((row) => ({
      id: row.id,
      title: row.title,
      metadata: row.metadata,
    })),
    nextCursor,
  };
}

/**
 * One Collection, or `undefined` when there is no such Collection — including when `id` is not
 * an identifier at all, which is the same answer to the caller.
 */
export async function readCollection(
  db: Database,
  id: string,
): Promise<Collection | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db
    .select(REPORTED)
    .from(collection)
    .where(eq(collection.id, id))
    .limit(1);
  return row;
}

/**
 * Renames a Collection, and replaces its metadata if it is named.
 *
 * The same `PATCH` every other correction on this surface is (ADR-0062): an absent field means
 * "leave it", a named `metadata` **replaces** what is stored rather than merging into it, and a
 * body naming nothing is refused rather than answered 200 with the row unchanged.
 *
 * **Which Products are in it is not corrected here**, and that asymmetry is a decision:
 * membership is `collections` on `PATCH /admin/products/{id}`, which is argued at
 * {@link parseCollectionMemberships}. A `products` here would be a second way to say the same
 * fact, permanent under ADR-0060, and the two could disagree about what an empty list means.
 *
 * No lock and no transaction: existence is what the `update` itself answers, and nothing about
 * this row is read before it is written.
 */
export async function updateCollection(
  db: Database,
  id: string,
  input: UpdateCollectionInput,
): Promise<CollectionUpdate> {
  const usable = readCollectionInput(input);
  if (!usable.ok) return usable;

  const changes = usable.changes;
  // Asked here rather than inside `readCollectionInput`, which `createCollection` shares: there
  // an empty result is a missing `title` rather than a no-op, and it is answered as one.
  if (Object.keys(changes).length === 0) {
    return changesNothing(
      "a `title`, a `metadata`, or both",
      "Which Products are in a Collection is not changed here: `collections` on `POST /admin/products` and on `PATCH /admin/products/{id}` is the whole set of the Collections one Product is in.",
    );
  }

  if (!isUuid(id)) return noSuchCollection(id);

  const [updated] = await db
    .update(collection)
    .set(changes)
    .where(eq(collection.id, id))
    .returning(REPORTED);
  if (!updated) return noSuchCollection(id);
  return { ok: true, collection: updated };
}

/**
 * Deletes a Collection, **ungrouping every Product that was in it and deleting none of them**
 * (story 17).
 *
 * One statement, and the join rows go with it because `core_product_collection.collection_id`
 * is `on delete cascade`. There is nothing to refuse and nothing to check first: a Collection
 * holding a thousand Products deletes exactly as one holding none does, which is what makes
 * organising a thing a Merchant can undo.
 */
export async function deleteCollection(
  db: Database,
  id: string,
): Promise<CollectionDeletion> {
  if (!isUuid(id)) return noSuchCollection(id);

  const [deleted] = await db
    .delete(collection)
    .where(eq(collection.id, id))
    .returning({ id: collection.id });
  if (!deleted) return noSuchCollection(id);
  return { ok: true };
}

/**
 * The columns a body names, narrowed — the one place a Collection's input is read, so creating
 * one and renaming one cannot disagree about what a title is.
 */
function readCollectionInput(input: CreateCollectionInput): Changes<CollectionColumns> {
  return changesFrom(
    { title: input.title, metadata: input.metadata },
    { title: text("title"), metadata: openData("metadata") },
  );
}

function noSuchCollection(id: string): {
  ok: false;
  reason: typeof COLLECTION_NOT_FOUND;
  detail: string;
} {
  return {
    ok: false,
    reason: COLLECTION_NOT_FOUND,
    detail: `No Collection with the identifier ${JSON.stringify(id)} exists. \`GET /admin/collections\` lists the ones this Store has.`,
  };
}

// ---- Which Products are in which Collections ---------------------------------------------

/**
 * A membership list naming a Collection this Store does not have.
 *
 * **422 rather than 400**, on `media-not-found`'s distinction and `unknown-fulfilment-strategy`'s
 * before it: the body is well formed — every entry is an object carrying a UUID — and what
 * refuses it is the state of the Store. It is the same word the Collection routes answer with,
 * because it is the same fact asked from the other end, and one fact gets one word (ADR-0060).
 */
export type CollectionMissing = {
  readonly ok: false;
  readonly reason: typeof COLLECTION_NOT_FOUND;
  readonly detail: string;
};

type Parsed<V> = { readonly ok: true; readonly value: V } | NotUsable;

/**
 * The Collections a request wants this Product in — `[]` where it named none, which is how it is
 * taken out of every one of them at once.
 *
 * **The whole list rather than an add and a remove, and only half of `media`'s argument for that
 * carries.** The half that does: a list of edits leaves no way to say *and this one is gone*, so
 * `POST …/collections/{id}` and `DELETE …/collections/{id}` would be two more permanent paths
 * (ADR-0060) saying what one field says, each needing its own answer to what an unknown
 * Collection means. The half that does **not** is the order — a Product's images are shown in the
 * order a Merchant set (story 9) and a Product's Collections are a *set*, so there is no
 * `position` column here and the order of the array means nothing on the way in. What comes back
 * is by title, which is the only column of a Collection a Merchant would recognise.
 *
 * **It is on the create as well as on the correction, and `media` is not** (#280). The two
 * absences read alike and were not the same thing: Media is bytes uploaded at a route of its own
 * that answers an identifier, so attaching is a second act however a create is shaped, while a
 * Collection is a row that already exists — so the only thing keeping this off the create was
 * that nothing had needed it, and grouping a hundred Products was two hundred requests. It is
 * **one reading** rather than two, which is what makes the same body refused in the same words
 * whichever route a Merchant sent it to; what differs is only what an *absent* field means. At
 * the correction absent is "leave it" and `[]` takes the Product out of everything (ADR-0062);
 * at a create the two are one fact, because a Product being made is in nothing to be left in.
 *
 * It is still not `options`' argument. A Variant naming an option its Product has not declared
 * must not exist for an instant, and there is no such state here — a Product that is in no
 * Collection for the length of one more request is an ordinary Product. What put this on the
 * create is the request a client no longer makes twice, not a state that must never exist.
 */
export function parseCollectionMemberships(value: unknown): Parsed<string[]> {
  if (!Array.isArray(value)) {
    return notUsable(
      '`collections` must be the complete list of the Collections this Product is in — e.g. [{ "id": "…" }]. An empty list takes it out of every one of them, and deletes no Collection.',
    );
  }

  const memberships: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return notUsable("Each entry in `collections` must be an object with an `id`.");
    }

    const id = trimmed(entry.id);
    if (id === undefined || !isUuid(id)) {
      return notUsable(
        "Each entry in `collections` must carry the `id` of a Collection — `GET /admin/collections` lists them.",
      );
    }

    // A Product is in a Collection or it is not; there is no second membership for the unique
    // index to distinguish, and it would refuse the second row from inside a transaction as a
    // 500 rather than as this sentence.
    if (seen.has(id)) {
      return notUsable(
        `\`collections\` names ${JSON.stringify(id)} twice. A Product is in a Collection once — this is a set rather than an ordered list.`,
      );
    }
    seen.add(id);

    memberships.push(id);
  }

  return { ok: true, value: memberships };
}

/**
 * The Collections of however many Products, keyed by Product and each list **by title**.
 *
 * One query rather than one per Product, and a join rather than two reads, because the
 * membership lives on the join row and everything reported lives on the Collection. A Product in
 * nothing is simply absent from the map, which is every Product until somebody groups it.
 */
export async function readProductCollections(
  db: Queryable,
  productIds: readonly string[],
): Promise<Map<string, Collection[]>> {
  if (productIds.length === 0) return new Map();

  const rows = await db
    .select({ subject: productCollection.productId, ...REPORTED })
    .from(productCollection)
    .innerJoin(collection, eq(collection.id, productCollection.collectionId))
    .where(inArray(productCollection.productId, [...new Set(productIds)]))
    // By title, because there is no order on a set and this is the one column of a Collection a
    // Merchant would recognise. `id` breaks the tie, because a title is deliberately not unique
    // — so the order is total rather than merely usual.
    .orderBy(asc(collection.title), asc(collection.id));

  const grouped = new Map<string, Collection[]>();
  for (const { subject, ...row } of rows) {
    const existing = grouped.get(subject);
    if (existing) existing.push(row);
    else grouped.set(subject, [row]);
  }
  return grouped;
}

/**
 * Serialises every change to one Product's memberships, for the length of the transaction.
 *
 * `lockMediaOf`'s departure from ADR-0018, taken for its reason: setting a set is a `delete` of
 * every row and an `insert` of the new ones, so two of them arriving together are four statements
 * interleaved — with no overlap the Product ends up in the union of two requests, and with an
 * overlap the second `insert` meets the unique index and travels as a 500 on a well formed
 * request. `lockProduct` cannot stand in for it: that lock is `for share`, and two `FOR SHARE`
 * holders do not conflict.
 */
export async function lockCollectionsOf(
  tx: Transaction,
  productId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${PRODUCT_COLLECTIONS_LOCK_NAMESPACE}, hashtext(${productId}))`,
  );
}

/** The namespace every change to a Product's memberships serialises in, per Product. */
const PRODUCT_COLLECTIONS_LOCK_NAMESPACE = 274_118_960;

/**
 * Which of these identifiers name no Collection, as the refusal that says so — or `undefined`.
 *
 * **It is the caller's to ask, before the caller's *first* write** (#255). A refusal
 * `updateProduct` returns from inside its transaction **commits** it, so a judgement made after
 * the Product's options had already been corrected would answer 422 over a Product whose options
 * really had been renamed. So the question is exported and {@link setProductCollections} is a
 * write and nothing else. `createProduct` asks it as its transaction's **first statement**, where
 * the failure is worse and louder: a Product judged after the `insert` is one a refused request
 * leaves behind, holding the handle and the SKUs the Merchant is about to send again.
 *
 * A read rather than the foreign key's own answer, because the key can only say that *a*
 * reference was bad and this can name which. A Collection deleted in the window between the two
 * travels as the 500 it is — which is a narrower window than Media's, since the lock below is
 * already held.
 */
export async function collectionsThisStoreDoesNotHave(
  tx: Transaction,
  collectionIds: readonly string[],
): Promise<CollectionMissing | undefined> {
  if (collectionIds.length === 0) return undefined;

  const found = await tx
    .select({ id: collection.id })
    .from(collection)
    .where(inArray(collection.id, [...collectionIds]));
  const known = new Set(found.map((row) => row.id));

  const missing = collectionIds.filter((id) => !known.has(id));
  if (missing.length === 0) return undefined;

  return {
    ok: false,
    reason: COLLECTION_NOT_FOUND,
    detail: `\`collections\` names ${missing.map((id) => JSON.stringify(id)).join(", ")}, which this Store has no Collection for. \`GET /admin/collections\` lists the ones it does, and \`POST /admin/collections\` makes another.`,
  };
}

/**
 * Puts this Product in exactly these Collections, and in no others.
 *
 * **Delete then insert, never a reconciliation.** The list is the fact, so writing it whole is
 * what makes an entry left out actually a Product taken out of that Collection — and it is what
 * lets the unique index on `(product_id, collection_id)` stand, since no row on its way in can
 * collide with one on its way out. Nothing here deletes a Collection: what goes is a membership.
 *
 * **It judges nothing**, which is {@link collectionsThisStoreDoesNotHave}'s subject: the caller
 * has asked that question already, ahead of every write its request makes. It has also taken
 * {@link lockCollectionsOf} and then `lockProduct`, in that order — the first is what makes the
 * pair below one operation, and the second is existence, so the rows written here cannot
 * reference a Product that has gone.
 */
export async function setProductCollections(
  tx: Transaction,
  productId: string,
  collectionIds: readonly string[],
): Promise<void> {
  await tx.delete(productCollection).where(eq(productCollection.productId, productId));
  if (collectionIds.length > 0) {
    await tx
      .insert(productCollection)
      .values(collectionIds.map((collectionId) => ({ productId, collectionId })));
  }
}

// ---- `?collection=` ------------------------------------------------------------------------

/**
 * The predicate both Product lists narrow by, and the one place `?collection=` is a `where`.
 *
 * **An `exists` against the join rather than a join in the list's own query**, deliberately: a
 * join would multiply nothing today — the unique index makes a Product a member once — but it
 * puts the join table in the `from` of the statement the cursor's ordering is evaluated in, where
 * the next filter on the same list would have to reason about it. An `exists` is a predicate, and
 * predicates compose with `and`, which is what makes the two entries in `filtering.test.ts` one
 * mechanism.
 *
 * It is deliberately **just the membership**: the store surface's `published` sits beside it in
 * the same `and`, contributed by `catalog/store-read.ts`, so this filter is no way round the one
 * rule that route enforces. Handing a `status` in here would have been exactly that.
 */
export function inCollection(collectionId: string): SQL {
  return sql`exists (select 1 from ${productCollection} where ${productCollection.productId} = ${product.id} and ${productCollection.collectionId} = ${collectionId}::uuid)`;
}

/**
 * The refusal for a `?collection=` naming no Collection — or `undefined` where it names one.
 *
 * **400 and not an empty page**, which is the filtering convention's second promise arriving at
 * the first filter whose values are not a closed set (#209, #252). A `status` outside the three
 * is refused by the schema, because the schema knows the three; whether a Collection *exists* is
 * a fact about the Store and no schema can hold it. So the question is asked here and answered
 * with the same `invalid` at the same status — an unusable query parameter does not fit the
 * endpoint, which is what that word already means everywhere on this surface, and a `reason` of
 * its own would be permanent under ADR-0060 for a distinction no client can act on.
 *
 * **One answer covers a value that is not a UUID and a UUID naming nothing**, because they are
 * one mistake: this parameter takes the identifier of a Collection, and neither of those is one.
 * Splitting them would be two sentences for *there is no such Collection*.
 *
 * It is asked **before** the page is read rather than folded into it, so an unknown Collection
 * cannot arrive as a 200 with an empty `products` — which is the exact failure the promise names,
 * and the one a caller reads as the truth.
 */
export async function unknownCollection(
  db: Database,
  collectionId: string,
): Promise<NotUsable | undefined> {
  const said = `\`collection\` names ${JSON.stringify(collectionId)}, which is not a Collection this Store has. Send the \`id\` of one — \`GET /admin/collections\` lists them — or leave the parameter out for the whole list.`;

  if (!isUuid(collectionId)) return notUsable(said);

  const [found] = await db
    .select({ id: collection.id })
    .from(collection)
    .where(eq(collection.id, collectionId))
    .limit(1);
  return found ? undefined : notUsable(said);
}
