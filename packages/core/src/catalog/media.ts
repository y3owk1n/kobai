import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Queryable, Transaction } from "../db/client.ts";
import { media, productMedia, variantMedia } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { isJsonObject, trimmed } from "../input.ts";
import { type Media, type ReportableMedia, reportedMedia } from "../media/media.ts";
import type { MediaStorage } from "../media/storage.ts";
import { type NotUsable, notUsable } from "../patch.ts";

/**
 * The Media a Product shows, and the Media one Variant shows — **in the order a Merchant set**
 * (#255, stories 9 and 10).
 *
 * #254 gave kobai a Media that exists and is addressable; this is what makes it catalog data.
 * Three things follow, and each is a decision rather than an implementation detail:
 *
 * **A Media belongs to the Store, not to the thing it is showing.** Attaching is a row in a join
 * table and detaching is that row going away, so the same image may lead on two Products, and a
 * deleted Product takes its attachments and leaves the asset in the library. What becomes of a
 * Media nothing references — bytes included — is
 * [ADR-0082](../../../../docs/adr/0082-a-detached-media-is-still-the-stores.md): **nothing
 * whatever**. There is no cascade, no sweep and no route that deletes one, and both `media_id`
 * columns are `on delete restrict` so that a hand-run `DELETE` cannot leave a Product showing a
 * row that is not there either.
 *
 * **The order is a Merchant's decision, so it is written down.** Story 9 is that the first image
 * leads, and a storefront that had to invent an order would invent a different one from the
 * Admin's. So the wire carries the whole list in the order it should end up in — `options`'
 * bargain in `catalog/options.ts`, for its reason: a list of edits leaves no way to say *and
 * this one is gone*, and the order is a property of the list rather than of any entry in it.
 * Attaching, reordering and detaching are therefore one request and one field, which is why
 * there is no `POST …/media` and no `DELETE …/media/{mediaId}` beside the `PATCH`.
 *
 * **A Media is attached to a Product that already exists, never in the create.** The bytes go up
 * at `POST /admin/media` and that route answers with an identifier, so attaching is a second act
 * however the surface is shaped — unlike a Product's options, which are in the create precisely
 * so that a Variant naming an option its Product has not declared does not exist for an instant.
 * There is no such state to make impossible here, so a `media` on the create would be a second
 * way to say what the correction already says (ADR-0060 makes each of those permanent).
 */

/** The one word both corrections refuse an attachment with. */
export const MEDIA_NOT_FOUND = "media-not-found";

/**
 * A list naming a Media this Store does not have.
 *
 * **422 rather than 400**, on `unknown-fulfilment-strategy`'s distinction: the body is well
 * formed — every entry is an object carrying a UUID — and what refuses it is the state of the
 * Store. It is the word `GET /media/{key}` already answers with, because it is the same fact
 * asked from the other end, and one fact gets one word (ADR-0060).
 */
export type MediaMissing = {
  readonly ok: false;
  readonly reason: typeof MEDIA_NOT_FOUND;
  readonly detail: string;
};

type Parsed<V> = { readonly ok: true; readonly value: V } | NotUsable;

/**
 * The Media a request wants shown, in the order it wants them — `[]` where it named none, which
 * is how everything is detached at once.
 *
 * **It takes no `possessive` the way `parseOptionValues` does**, and the reason is this module's
 * own decision one paragraph up: `media` is only ever on a correction, and a correction
 * addresses one Product or one Variant. There is no body naming several subjects, so there is no
 * entry a refusal would have to point at — and a parameter for a caller that does not exist
 * would be bought against a route the surface deliberately does not have.
 */
export function parseMediaAttachments(value: unknown): Parsed<string[]> {
  if (!Array.isArray(value)) {
    return notUsable(
      '`media` must be the complete list of the Media this shows, in the order it should be shown in — e.g. [{ "id": "…" }]. An empty list detaches everything, and deletes nothing.',
    );
  }

  const attached: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return notUsable("Each entry in `media` must be an object with an `id`.");
    }

    const id = trimmed(entry.id);
    if (id === undefined || !isUuid(id)) {
      return notUsable(
        "Each entry in `media` must carry the `id` `POST /admin/media` answered with.",
      );
    }

    // One picture takes one place in a list. The same Media twice would be two positions for one
    // image with nothing able to say which was meant — and the unique index would refuse the
    // second row from inside a transaction, as a 500 rather than as this sentence.
    if (seen.has(id)) {
      return notUsable(
        `\`media\` names ${JSON.stringify(id)} twice. One image is shown once, and where it is shown is its place in this list.`,
      );
    }
    seen.add(id);

    attached.push(id);
  }

  return { ok: true, value: attached };
}

/**
 * The Media of however many Products, keyed by Product and each list **in its own order**.
 *
 * One query rather than one per Product, and a join rather than two reads, because the order
 * lives on the join row and everything reported lives on the Media. A Product showing nothing is
 * simply absent from the map, which is every Product until somebody attaches something.
 */
export async function readProductMedia(
  db: Queryable,
  storage: MediaStorage,
  productIds: readonly string[],
): Promise<Map<string, Media[]>> {
  if (productIds.length === 0) return new Map();

  const rows = await db
    .select({ subject: productMedia.productId, ...MEDIA_COLUMNS })
    .from(productMedia)
    .innerJoin(media, eq(media.id, productMedia.mediaId))
    .where(inArray(productMedia.productId, [...new Set(productIds)]))
    // `id` breaks the tie. Positions are rewritten dense from every request that sets them, so
    // nothing should ever tie — which is exactly the kind of thing a total order should not be
    // left resting on.
    .orderBy(asc(productMedia.position), asc(productMedia.id));

  return bySubject(rows, storage);
}

/** The same, for Variants — the half that lets a storefront swap the picture with the Colour. */
export async function readVariantMedia(
  db: Queryable,
  storage: MediaStorage,
  variantIds: readonly string[],
): Promise<Map<string, Media[]>> {
  if (variantIds.length === 0) return new Map();

  const rows = await db
    .select({ subject: variantMedia.variantId, ...MEDIA_COLUMNS })
    .from(variantMedia)
    .innerJoin(media, eq(media.id, variantMedia.mediaId))
    .where(inArray(variantMedia.variantId, [...new Set(variantIds)]))
    .orderBy(asc(variantMedia.position), asc(variantMedia.id));

  return bySubject(rows, storage);
}

/**
 * Serialises every change to one subject's attachments, for the length of the transaction.
 *
 * **A `pg_advisory_xact_lock` rather than a row lock**, which is `lockProductOptions`'s
 * departure from ADR-0018 and is taken for the same reason: setting a list is a `delete` of
 * every row and an `insert` of the new ones, so two of them arriving together are four
 * statements interleaved. The failure is real in both directions — with no overlap between the
 * two lists both survive and the Product shows the union of two requests, and with an overlap
 * the second `insert` meets the unique index and travels as a 500 on a well formed request.
 * `lockProduct` cannot stand in for it: that lock is `for share`, and two `FOR SHARE` holders do
 * not conflict.
 *
 * **One namespace for both tables, keyed by the subject.** A Product's identifier and a
 * Variant's are drawn from the same 122-bit space and cannot collide, so a second namespace
 * would buy nothing; a `hashtext` collision costs a wait and never a wrong answer, because the
 * lock decides who writes first and never what they write.
 */
export async function lockMediaOf(tx: Transaction, subjectId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${MEDIA_ATTACHMENT_LOCK_NAMESPACE}, hashtext(${subjectId}))`,
  );
}

/** The namespace every change to a Product's or a Variant's Media serialises in, per subject. */
const MEDIA_ATTACHMENT_LOCK_NAMESPACE = 380_915_244;

/**
 * Which of these identifiers name no Media, as the refusal that says so — or `undefined`.
 *
 * **It is the caller's to ask, before the caller's *first* write, and that is not tidiness.** A
 * refusal `updateProduct` returns from inside its transaction **commits** it, so a judgement made
 * after a correction of the Product's options had already run would answer 422 over a Product
 * whose options had really been renamed. So the question is exported and the two writes below
 * are writes and nothing else — which makes "every judgement before every write" a property of
 * this module's shape rather than of the order somebody happened to call it in.
 *
 * A read rather than the foreign key's own answer, because the key can only say that *a*
 * reference was bad and this can name which. The window between the two is not one anything on
 * this surface can reach: nothing deletes a Media (ADR-0082), and the `restrict` on both
 * `media_id` columns is what keeps that true of a hand-run `DELETE` as well. A Media that went in
 * between travels as the 500 it is.
 */
export async function mediaThisStoreDoesNotHave(
  tx: Transaction,
  mediaIds: readonly string[],
): Promise<MediaMissing | undefined> {
  if (mediaIds.length === 0) return undefined;

  const found = await tx
    .select({ id: media.id })
    .from(media)
    .where(inArray(media.id, [...mediaIds]));
  const known = new Set(found.map((row) => row.id));

  const missing = mediaIds.filter((id) => !known.has(id));
  if (missing.length === 0) return undefined;

  return {
    ok: false,
    reason: MEDIA_NOT_FOUND,
    detail: `\`media\` names ${missing.map((id) => JSON.stringify(id)).join(", ")}, which this Store has no Media for. Upload the image at \`POST /admin/media\` and attach the \`id\` that answers with; \`GET /admin/media\` lists what there is.`,
  };
}

/**
 * Sets what a Product shows: exactly this list, in this order.
 *
 * **Delete then insert, never a reconciliation.** The list is the fact, so writing it whole is
 * what makes an entry left out actually detached — and it is what lets the unique index on
 * `(product_id, media_id)` stand, since no row on its way in can collide with one on its way
 * out. Nothing here deletes a Media: what goes is an attachment, and the asset is still in the
 * library and may still be showing on something else (ADR-0082).
 *
 * **It judges nothing**, which is {@link mediaThisStoreDoesNotHave}'s subject: the caller has
 * asked that question already, ahead of every write its request makes. It has also taken
 * {@link lockMediaOf} and then `lockProduct`, in that order — the first is what makes the pair
 * below one operation, and the second is existence, so the rows written here cannot reference a
 * Product that has gone.
 */
export async function setProductMedia(
  tx: Transaction,
  productId: string,
  mediaIds: readonly string[],
): Promise<void> {
  await tx.delete(productMedia).where(eq(productMedia.productId, productId));
  if (mediaIds.length > 0) {
    await tx
      .insert(productMedia)
      .values(mediaIds.map((mediaId, position) => ({ productId, mediaId, position })));
  }
}

/**
 * The same, for one Variant — story 10, and the reason there are two tables (`db/schema.ts`).
 *
 * A second function rather than one taking a table and a row builder: the two tables' rows differ
 * in the column they name, so the shared version is this one with two callbacks threaded through
 * it, which is more machinery than the four lines it saves. The half that genuinely is one thing
 * — what a Media reports, and what refuses a list — is {@link MEDIA_COLUMNS} and
 * {@link mediaThisStoreDoesNotHave}, and there is one of each.
 */
export async function setVariantMedia(
  tx: Transaction,
  variantId: string,
  mediaIds: readonly string[],
): Promise<void> {
  await tx.delete(variantMedia).where(eq(variantMedia.variantId, variantId));
  if (mediaIds.length > 0) {
    await tx
      .insert(variantMedia)
      .values(mediaIds.map((mediaId, position) => ({ variantId, mediaId, position })));
  }
}

/**
 * The columns a Media is read from wherever it is attached, and the one place they are named.
 *
 * The storage key is among them because {@link reportedMedia} is what trades it for the address
 * — asked of the deployment's `MediaStorage` on every read and never stored (ADR-0078) — so it
 * is read and does not reach the wire.
 */
const MEDIA_COLUMNS = {
  id: media.id,
  storageKey: media.storageKey,
  contentType: media.contentType,
  filename: media.filename,
  byteSize: media.byteSize,
  width: media.width,
  height: media.height,
  alt: media.alt,
} as const;

/** One row per attachment, folded into one list per subject, in the order they came back. */
function bySubject(
  rows: readonly (ReportableMedia & { readonly subject: string })[],
  storage: MediaStorage,
): Map<string, Media[]> {
  const attached = new Map<string, Media[]>();
  for (const { subject, ...row } of rows) {
    const one = reportedMedia(row, storage);
    const existing = attached.get(subject);
    if (existing) existing.push(one);
    else attached.set(subject, [one]);
  }
  return attached;
}
