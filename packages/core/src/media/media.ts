import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
import { type MediaRow, media } from "../db/schema.ts";
import { trimmed } from "../input.ts";
import { imageDimensions } from "./dimensions.ts";
import { type MediaPolicy, type MediaStorage, normaliseContentType } from "./storage.ts";

/**
 * Media, as Core keeps it: the record here, the bytes wherever the deployment's
 * {@link MediaStorage} put them (ADR-0015).
 *
 * Every function takes the storage as an argument rather than importing one, exactly as the
 * catalog takes its `FulfilmentStrategies`: which storage this is belongs to the instance, and a
 * module that reached for a default would be a second answer to a question `kobai.config.ts`
 * already settles.
 */

/** One asset, as every route reports it. */
export type Media = {
  readonly id: string;
  /**
   * Where the bytes are — the storage's own answer, asked at read time and never stored.
   *
   * Absolute for a storage with an address of its own; `/media/{key}` for the one Core ships,
   * whose bytes kobai serves. A client renders it and asks nothing else about it.
   */
  readonly url: string;
  readonly contentType: string;
  readonly filename: string;
  readonly byteSize: number;
  /** Pixels, or `null` where the format's header could not be read (`media/dimensions.ts`). */
  readonly width: number | null;
  readonly height: number | null;
  /** What this shows, for a Shopper who cannot see it — `null` until somebody writes it. */
  readonly alt: string | null;
};

/** What an upload carries, once the route has taken the multipart body apart. */
export type MediaUploadInput = {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly alt?: unknown;
};

/**
 * Uploading refuses three ways, and they are three different fixes.
 *
 * `invalid` is the request's own word for a part with no bytes in it. The other two are what
 * this deployment will take — `media-too-large` for a file over `media.maxBytes` and
 * `content-type-not-accepted` for one whose declared type is not in `media.accept` — and they
 * are **two words rather than one** deliberately: a Merchant answers the first by exporting the
 * image smaller and the second by exporting it as something else, and a client that could only
 * be told "this upload was refused" would have to put both sentences in front of somebody who
 * needs one. That is the same distinction `invalid` and `malformed-body` already draw, and one
 * word here would be as permanent as two (ADR-0060) while saying less.
 *
 * A storage that will not take the write is not in here: that is a broken deployment rather
 * than a badly formed request, so it throws and travels as the 500 it is
 * ({@link MediaStorage.put}).
 */
export type MediaUploadOutcome =
  | { readonly ok: true; readonly media: Media }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "media-too-large" | "content-type-not-accepted";
      readonly detail: string;
    };

/**
 * Stores the bytes, then records them.
 *
 * **In that order, and the order is the decision.** The row carries the storage key, so it
 * cannot be written before there is one; and a row written first would be an addressable Media
 * whose bytes are not there yet, which is a worse thing to have than what this leaves behind if
 * the insert fails — an object nothing points at. Nothing collects those, because nothing in
 * kobai deletes Media or bytes at all (ADR-0082), and an orphaned object is what every object
 * store deployment already tolerates. When a delete arrives, so does the sweep for these.
 *
 * The dimensions are read from the bytes here rather than by the storage, because they are a
 * fact about the file and every storage would otherwise have to read them again — and one that
 * did it wrong would be a Store laying its storefront out against a number nothing checked.
 */
export async function uploadMedia(
  db: Database,
  storage: MediaStorage,
  policy: MediaPolicy,
  input: MediaUploadInput,
): Promise<MediaUploadOutcome> {
  // A file part with no bytes in it. The schema cannot see this — an empty upload is a
  // perfectly well formed `File` — and storing it would give a Merchant a Media whose URL
  // serves nothing, which they would find out about from their storefront.
  if (input.bytes.byteLength === 0) {
    return { ok: false, reason: "invalid", detail: "The uploaded file is empty." };
  }

  const filename = trimmed(input.filename) ?? "upload";
  const contentType = trimmed(input.contentType) ?? "application/octet-stream";

  // **Both of these are decided before `storage.put`, and that ordering is the decision.**
  // `MediaStorage` has no `remove` (ADR-0078, confirmed by #255), so a refusal made after the
  // write is an object no route in kobai can ever delete — a Merchant's mistake turned into a
  // permanent line on their storage bill. There is nothing to weigh against putting them here:
  // both facts are known from what is already in memory.
  const measured = refuseSize(input.bytes.byteLength, policy);
  if (measured) return measured;

  // After the size and not before it, so that a file that is both too big and the wrong kind is
  // answered the same way whichever check saw it first — the declared-size check at the route
  // has no content type to judge, so leading with the type would make the word depend on how
  // the request happened to announce itself.
  const declared = normaliseContentType(contentType);
  if (!policy.accept.includes(declared)) {
    return {
      ok: false,
      reason: "content-type-not-accepted",
      detail: `This Store takes ${policy.accept.join(", ")}, and this file declared ${JSON.stringify(declared === "" ? contentType : declared)}. It is what the file part said it was rather than anything kobai read out of the bytes, so a file saved with the wrong extension is refused here too — export it as one of those and upload it again.`,
    };
  }

  // `null` rather than `""` for alt text nobody wrote: a Merchant who has not got to it and one
  // who deliberately says nothing are told apart by exactly this, and a storefront rendering
  // `alt=""` on the first would be telling a screen reader the image is decorative.
  const alt = typeof input.alt === "string" ? (trimmed(input.alt) ?? null) : null;

  const stored = await storage.put({ filename, contentType, bytes: input.bytes });
  const size = imageDimensions(input.bytes);

  const [row] = await db
    .insert(media)
    .values({
      storageKey: stored.key,
      contentType,
      filename,
      byteSize: input.bytes.byteLength,
      width: size?.width ?? null,
      height: size?.height ?? null,
      alt,
    })
    .returning();
  if (!row) throw new Error("inserting a Media returned no row");

  return { ok: true, media: reportedMedia(row, storage) };
}

/** A refusal, as {@link uploadMedia} and the route's own pre-check both answer with one. */
type RefusedUpload = Extract<MediaUploadOutcome, { readonly ok: false }>;

/**
 * The ceiling, judged against bytes that are really there.
 *
 * **This is the honest half of the answer to "where is an upload refused?", and it is the half
 * that decides.** It is asked of a `byteLength`, so nothing can lie to it — but it can only be
 * asked once the file is in memory, which is the very cost the ceiling exists to bound. That is
 * the whole of the tension #278 posed, and neither half of it resolves the other: a check that
 * measures cannot come first, and a check that comes first cannot measure.
 *
 * So kobai does both, and this is the one that says what the answer is. What
 * {@link refuseDeclaredSize} adds is that the ordinary large upload never reaches here.
 */
function refuseSize(byteLength: number, policy: MediaPolicy): RefusedUpload | undefined {
  if (byteLength <= policy.maxBytes) return undefined;

  return {
    ok: false,
    reason: "media-too-large",
    detail: `${ceilingIs(policy)}, and this one is ${byteLength}. ${WHERE_THE_CEILING_IS_SET}`,
  };
}

/** What this Store takes, said once, because two refusals say it. */
function ceilingIs(policy: MediaPolicy): string {
  return `This Store takes files up to ${policy.maxBytes} bytes`;
}

/** Where a Merchant's Developer goes to change it — the other half both refusals share. */
const WHERE_THE_CEILING_IS_SET =
  "It is `media.maxBytes` in the Project's kobai.config.ts that decides, so a Store that wants larger assets raises it there.";

/**
 * The same ceiling, judged against what the request *says* about itself — before a byte of it
 * has been read.
 *
 * **This is the cheap half, and it is the only check that can prevent the thing the ceiling is
 * for.** By the time a handler exists, `multipart/form-data` has been parsed and the whole part
 * is on the heap: the parser is where the memory goes, so a ceiling enforced after it bounds
 * what is *stored* and bounds nothing about what is *held*. Refusing on `Content-Length` — from
 * route middleware, ahead of the body validator — costs a header lookup and means a Merchant
 * who dragged in a video is answered immediately rather than after uploading it.
 *
 * **It is deliberately loose in one direction and must stay that way.** What it has is the size
 * of the whole multipart envelope — boundaries, part headers and the `alt` field as well as the
 * file — so comparing it against `maxBytes` exactly would refuse a file of precisely the
 * ceiling for bytes that are not the file's. So it allows {@link ENVELOPE_ALLOWANCE} on top: it
 * exists to turn away the obviously-too-big without reading it, and everything near the line is
 * decided honestly one level down.
 *
 * **What that buys is a bound rather than a guarantee, and the difference is worth stating.**
 * This check refuses nothing {@link refuseSize} would accept *provided the request's non-file
 * bytes come to less than the allowance* — which every browser's envelope does by three orders
 * of magnitude, and which a caller sending sixty-four kilobytes of `alt` text does not. Nothing
 * bounds `alt`, deliberately: a length limit on it would be a second promised refusal, on a
 * field nobody has asked for one about, to close a case that reads as a client bug rather than
 * as a Merchant's upload. The consequence is stated rather than mitigated — such a request is
 * answered `media-too-large`, which is the right status about the wrong half of the body — and
 * the day `alt` earns a bound, this allowance is what it should be set against.
 *
 * `undefined` for a request that declares nothing — a chunked upload has no `Content-Length` at
 * all — and for a header that is not a number. Neither is a refusal: a request that will not
 * say how big it is has told this check nothing, and {@link refuseSize} is what it then meets.
 * Which is also the honest limit of all this: **a client that lies about its length, or sends
 * none, still gets its bytes buffered before it is turned back**, and closing that needs a
 * streaming multipart parser rather than a bigger number here.
 */
export function refuseDeclaredSize(
  contentLength: string | undefined | null,
  policy: MediaPolicy,
): RefusedUpload | undefined {
  if (contentLength === undefined || contentLength === null) return undefined;

  const declared = Number(contentLength);
  if (!Number.isSafeInteger(declared) || declared < 0) return undefined;
  if (declared <= policy.maxBytes + ENVELOPE_ALLOWANCE) return undefined;

  return {
    ok: false,
    reason: "media-too-large",
    // The file's own size is not knowable here and this sentence does not pretend it is: it
    // reports what the request declared, and names the ceiling that request cannot fit under.
    detail: `${ceilingIs(policy)}, and this request declares ${declared} bytes of body. Nothing was read. ${WHERE_THE_CEILING_IS_SET}`,
  };
}

/**
 * How much of a request is allowed to be something other than the file, for the check that
 * cannot tell them apart.
 *
 * 64 KiB is far more than a multipart envelope and its `alt` field will ever come to, which is
 * the point: this number is slack for a check that must not be exact, not a second limit. Make
 * it tight and a file of exactly `maxBytes` starts being refused for the boundary string that
 * carried it.
 */
const ENVELOPE_ALLOWANCE = 64 * 1024;

/**
 * A page of Media, newest first — a Merchant listing them has just uploaded one and is looking
 * for it, which is the same argument every other list here makes (ADR-0064).
 *
 * It takes no filter, so there is no entry for it in `http/filtering.test.ts` and none is owed:
 * a filter is added to a list, and this one narrows by nothing yet.
 */
export async function listMedia(
  db: Database,
  storage: MediaStorage,
  page: PageRequest,
): Promise<Page<Media>> {
  const rows = await db
    .select({
      id: media.id,
      storageKey: media.storageKey,
      contentType: media.contentType,
      filename: media.filename,
      byteSize: media.byteSize,
      width: media.width,
      height: media.height,
      alt: media.alt,
      cursorAt: cursorAt(media.createdAt),
    })
    .from(media)
    .where(rowsAfter(page, media.createdAt, media.id))
    .orderBy(desc(media.createdAt), desc(media.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  return { items: found.map((row) => reportedMedia(row, storage)), nextCursor };
}

/** The bytes behind one key, and what to serve them as — or nothing. */
export type ServedMedia = {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
};

/**
 * What `GET /media/{key}` answers with, or `undefined`.
 *
 * **The row is read first and the content type comes off it**, never off the file: the storage
 * holds bytes and has never been asked what they are, and a byte route that sniffed them would
 * be a second opinion about a fact the upload already recorded.
 *
 * `undefined` covers three things a caller cannot tell apart and should not: no such key, a key
 * whose object has gone missing, and a storage that answers `null` because its bytes are not
 * kobai's to serve. The last is the ordinary case for a Store on a CDN, whose Media report
 * absolute URLs and whose byte route is therefore never asked.
 */
export async function readMediaBytes(
  db: Database,
  storage: MediaStorage,
  key: string,
): Promise<ServedMedia | undefined> {
  const [row] = await db
    .select({ contentType: media.contentType })
    .from(media)
    .where(eq(media.storageKey, key))
    .limit(1);
  if (!row) return undefined;

  const bytes = await storage.read(key);
  return bytes === null
    ? undefined
    : { bytes: writable(bytes), contentType: row.contentType };
}

/**
 * The bytes as a response body will take them.
 *
 * A `Uint8Array` in TypeScript's spelling may be a view onto a `SharedArrayBuffer`, and a
 * response body may not be — so a storage's answer is narrowed here rather than at every caller.
 * It re-views the same memory, which is free, and copies only the shared case, which nothing in
 * kobai produces and no storage has any reason to.
 */
function writable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

/**
 * The columns {@link reportedMedia} needs, as a `Pick` of the row rather than a third spelling
 * of those eight: `schema.ts` names them and every query that reports a Media selects them, so a
 * column renamed there reaches this as a compile error rather than as a field quietly missing
 * from a response.
 *
 * Named and exported because a Media is now read in two places — here, and wherever one is
 * attached to a Product or a Variant (`catalog/media.ts`).
 */
export type ReportableMedia = Pick<
  MediaRow,
  | "id"
  | "storageKey"
  | "contentType"
  | "filename"
  | "byteSize"
  | "width"
  | "height"
  | "alt"
>;

/**
 * One row, as the surface reports it — the storage key traded for the address it resolves to.
 *
 * **Exported, because a Media reaches the wire from more than one route.** Uploading and listing
 * answer one, and a Product and a Variant carry the ones attached to them (#255); a second
 * function that turned a row into a response would be a second place for the `url` to stop being
 * asked of the storage (ADR-0078).
 */
export function reportedMedia(row: ReportableMedia, storage: MediaStorage): Media {
  return {
    id: row.id,
    url: storage.urlFor(row.storageKey),
    contentType: row.contentType,
    filename: row.filename,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    alt: row.alt,
  };
}
