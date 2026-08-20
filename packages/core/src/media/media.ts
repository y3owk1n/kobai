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
import type { MediaStorage } from "./storage.ts";

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
 * Uploading refuses one way, and it is the request's own word.
 *
 * A storage that will not take the write is not in here: that is a broken deployment rather
 * than a badly formed request, so it throws and travels as the 500 it is
 * ({@link MediaStorage.put}).
 */
export type MediaUploadOutcome =
  | { readonly ok: true; readonly media: Media }
  | { readonly ok: false; readonly reason: "invalid"; readonly detail: string };

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
