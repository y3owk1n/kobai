import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * **`MediaStorage`** — where a Merchant's catalog assets actually live, and the third named
 * interface a Project may substitute (ADR-0003's third Extension Point, ADR-0015).
 *
 * Core owns the Media *record* — `core_media`, the row carrying the storage key, the content
 * type, the dimensions and the alt text — and owns none of the bytes. A Store that wants its
 * images on S3, on R2 or behind a CDN writes an object satisfying this type and names it in one
 * line of `kobai.config.ts`:
 *
 * ```ts
 * // kobai.config.ts
 * export default defineKobaiConfig({ media: { storage: myBucket } });
 * ```
 *
 * ## Unlike `PaymentProvider`, Core ships one, and there is a recorded reason it may
 *
 * ADR-0053 has Core implement `PaymentProvider` nowhere, on the grounds that dependency
 * substitution had one named interface whose every implementation was Core's own (#72) — a
 * second such interface would have reproduced that finding rather than closed it. ADR-0051
 * closed it with two implementations from outside kobai, so Media no longer has to be the
 * proof, and the argument the other way wins here: a Store with no object store at all should
 * boot and should show its images. {@link filesystemMediaStorage} is what a deployment that
 * says nothing gets.
 *
 * ## Where the bytes come from when Media is read, which is this interface's real decision
 *
 * **The storage names the address, and kobai serves bytes only for a storage that asks it to.**
 * {@link MediaStorage.urlFor} is asked at every read and its answer is what reaches a
 * storefront — so a bucket behind a CDN answers `https://cdn.example.com/…` and **no image byte
 * ever passes through the application**. Proxying would have made kobai the bottleneck in front
 * of the one part of a storefront that is already solved by somebody else, and it would have
 * been unavoidable: a URL is a field on a response, and a field that always pointed at kobai
 * could not later be made to point anywhere else without a break.
 *
 * The URL is **asked** rather than stored, which is the other half of the same decision. A URL
 * written onto the row at upload is a copy of an answer the storage can still give, and it goes
 * wrong exactly when a Store does the thing this interface exists to allow — putting a CDN in
 * front of the bucket it already had, and finding a table full of addresses naming the old one.
 *
 * That leaves the storage Core ships, which has no address of its own: a file under a directory
 * is not reachable over HTTP by anything. So it answers a URL on **kobai's own** open byte route
 * — `GET /media/{key}`, which reads the row for its content type and asks
 * {@link MediaStorage.read} for the bytes. `read` is therefore on this interface **and returning
 * `null` from it is an ordinary answer**, meaning *my bytes are not kobai's to serve*: a bucket
 * whose `urlFor` points at a CDN writes `read: async () => null` and is complete. It is a
 * required member rather than an optional one deliberately — an optional operation makes a
 * substitute's completeness a thing you have to look up, where one line saying `null` states
 * the decision at the place somebody reads the object.
 *
 * **That byte route is open, and that is the part to be sure about before wiring anything.** An
 * `<img>` sends no credential, so a route only a bearer key could open would serve nothing to a
 * browser — which means everything the shipped storage holds is readable by anyone who knows a
 * key, exactly as a public bucket's objects are. Keys are unguessable (a v4 UUID, 122 bits from
 * the platform CSPRNG), and the route enumerates nothing: there is no listing, and
 * `GET /admin/media` is behind a Merchant session and `catalog:read`. Media is
 * **Merchant-supplied catalog data** and nothing else — ADR-0015 puts a Shopper's uploaded
 * artwork in the Project's own table precisely because it is not this — so publishable bytes is
 * what this store is for. A deployment holding assets that must not be public wires a storage
 * that signs its own URLs and serves none of them through kobai.
 *
 * ## The shape, and why it is this one
 *
 * Copied from a set rather than from whichever file was opened first: `PaymentProvider`,
 * `FulfilmentStrategy`, `ReservationProvider`, `Logger` and `Step.run` already agree, and
 * ADR-0019 puts an interface's shape under semver **forever** from the moment it ships.
 *
 * - **A plain object type, substituted whole.** No class, no base, no `init` and no `close` —
 *   Core never constructs a storage and never disposes of one, so a lifecycle would be a
 *   contract about something Core does not manage. An adapter around somebody's SDK is a
 *   three-line object.
 * - **Every operation is a property holding a function, never a method.** TypeScript checks
 *   method parameters bivariantly and function-property parameters contravariantly, so only
 *   this spelling makes a storage that demands **more** than Core sends a compile error rather
 *   than a runtime surprise. The plausible mistake here is
 *   `put: (upload: MediaUpload & { productId: string }) => …`, from an adapter that wants to lay
 *   its objects out per Product — and the honest answer is that Core has no Product to send at
 *   upload, because attaching Media to one is a separate act.
 * - **No `name`.** `PaymentProvider` carries one because a Payment has to say which system holds
 *   the money a year later, and a Reservation names who must give the units back. Nothing is
 *   recorded here about *which* storage wrote an object: there is one per deployment, and a
 *   deployment that changes storage has to move its objects rather than read them from two
 *   places.
 * - **No `remove`, and ADR-0082 declined to add one.** Nothing on the surface deletes Media —
 *   detaching an image from a Product removes the attachment and leaves the asset here — so an
 *   operation every implementer must write and nothing ever calls would be a promise bought with
 *   somebody else's work. Adding one later is a break for implementers rather than for callers,
 *   which ADR-0058 makes cheap only until the first publish, so it belongs to the ticket that
 *   gives a Merchant a way to delete an asset and is taken then rather than guessed at now.
 */
export type MediaStorage = {
  /**
   * Writes the bytes wherever this storage keeps them, and says what it called them.
   *
   * It throws rather than answering a refusal, and that asymmetry with
   * `PaymentProvider.charge` is deliberate: a declined card is an ordinary outcome a Shopper
   * acts on, while a bucket that will not take a write is a broken deployment. So a failure
   * here travels as the 500 it is.
   */
  readonly put: (upload: MediaUpload) => Promise<StoredMedia>;
  /**
   * The address this key is served at — what every read of a Media hands back, asked fresh
   * each time rather than stored.
   *
   * Synchronous and side-effect free, because it is asked once per row of a page: a storage
   * that had to call out to answer would make listing Media an *n*-request operation. A signed
   * URL with an expiry is still expressible — it is computed from a key and a secret the
   * storage already holds.
   */
  readonly urlFor: (key: string) => string;
  /**
   * The bytes, for a storage whose objects kobai serves — or **`null`**, which means *not
   * kobai's to serve* and is what a storage answering a URL of its own returns.
   *
   * `null` is also the answer for a key this storage does not hold, and the two need no telling
   * apart: `GET /media/{key}` answers `media-not-found` either way, and a client can act on
   * neither distinction.
   */
  readonly read: (key: string) => Promise<Uint8Array | null>;
};

/** What Core hands a storage: the bytes, and the two facts the upload declared about them. */
export type MediaUpload = {
  /**
   * The name the Merchant's own machine gave the file — `poster.png`.
   *
   * **Advisory.** A storage may take a hint from its extension and must not trust it: it is
   * whatever a browser was told by an operating system, and Core neither sanitises it nor
   * builds a path out of it.
   */
  readonly filename: string;
  /** What the upload declared the bytes are — `image/png`. Also stored on the record. */
  readonly contentType: string;
  /** The whole file, in memory. */
  readonly bytes: Uint8Array;
};

/** What a storage answers with: the one string that finds those bytes again. */
export type StoredMedia = {
  /**
   * This storage's own handle on the object — a filename, an S3 key, whatever it calls it.
   *
   * Core stores it, hands it back to {@link MediaStorage.urlFor} and
   * {@link MediaStorage.read}, and parses none of it. It is unique across the Store, so it is
   * what `GET /media/{key}` resolves — which means it also has to survive a URL path segment:
   * keep it to unreserved characters, and never put a `/` in one unless the byte route is
   * something your storage serves rather than kobai.
   */
  readonly key: string;
};

/**
 * What a Project says about Media in `kobai.config.ts` — a subject, not a scalar (ADR-0050).
 *
 * Nested so that the next thing a deployment needs to say about its Media — a size ceiling, an
 * accepted set of content types — goes beside the storage rather than forcing this shape after
 * the fact, which is the same reason `payments` is a key holding a provider instead of a
 * top-level `paymentProvider`.
 */
export type MediaOptions = {
  /**
   * Where this deployment's assets live. Absent is {@link filesystemMediaStorage} under
   * {@link DEFAULT_MEDIA_DIRECTORY} — a working Store rather than a refusal, because unlike a
   * Payment Provider there is a default that can honestly be shipped.
   */
  readonly storage?: MediaStorage;
};

/**
 * Where kobai's own open byte route is mounted, and so what the shipped storage's URLs begin
 * with.
 *
 * One statement of it: `http/app.ts` mounts the sub-app here and {@link filesystemMediaStorage}
 * builds its answers from it, so the address a Media reports and the address that serves it
 * cannot be two decisions.
 */
export const MEDIA_PATH = "/media";

/** Where the shipped storage writes when a Project names no directory. Relative to the process. */
export const DEFAULT_MEDIA_DIRECTORY = "kobai-media";

export type FilesystemMediaStorageOptions = {
  /**
   * The directory the files go in, created on first write.
   *
   * Relative paths are resolved against the process's working directory, which for a Project
   * generated by `create-kobai` is where `node dist/src/server.js` was started.
   */
  readonly directory?: string;
};

/**
 * The storage Core ships: files under a directory, served back by kobai's own byte route.
 *
 * **It is what a deployment that configures nothing gets**, and it is a real answer rather than
 * a stub — a Store selling from one machine can run on it indefinitely. What it is not is a
 * substitute for an object store: it holds bytes on **local disk**, so a deployment running two
 * containers has each of them holding half the catalog's images, and a container with no volume
 * mounted at this directory loses them on the next deploy. Both are properties of local disk
 * rather than of this code, and the answer to either is to wire a storage that has neither.
 *
 * The key is a UUID and the extension is taken from the content type: nothing a caller sent is
 * ever a path. A filename from a browser is whatever an operating system said, and building a
 * path out of one is how `../../etc` reaches a write.
 */
export function filesystemMediaStorage(
  options: FilesystemMediaStorageOptions = {},
): MediaStorage {
  const directory = resolve(options.directory ?? DEFAULT_MEDIA_DIRECTORY);

  return {
    put: async (upload) => {
      const key = `${randomUUID()}${extensionFor(upload.contentType)}`;
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, key), upload.bytes);
      return { key };
    },

    urlFor: (key) => `${MEDIA_PATH}/${encodeURIComponent(key)}`,

    read: async (key) => {
      // The one line standing between a path in a URL and this directory's parent. Core only
      // ever asks about a key it read out of `core_media`, so this can refuse nothing a working
      // deployment sends — which is exactly what makes it worth keeping: it is here for the day
      // some other caller is less careful, and `join` would resolve `..` without a word.
      if (!SAFE_KEY.test(key)) return null;

      try {
        return new Uint8Array(await readFile(join(directory, key)));
      } catch (cause) {
        if (isMissingFile(cause)) return null;
        throw cause;
      }
    },
  };
}

/**
 * What this storage will look for on disk: what it writes, and nothing that could leave the
 * directory.
 *
 * A whitelist rather than a search for `..` or `/`, because a denylist over path syntax is a
 * game nobody wins — percent-encoding, backslashes on some platforms, NUL bytes. Keys are this
 * module's own to invent, so it can afford to accept only what it invents.
 */
const SAFE_KEY = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9]+)?$/;

/**
 * The file extension for a content type, or none.
 *
 * A short table rather than a lookup, and its whole job is to make a file on disk openable by
 * double-clicking it — nothing reads it back, because the content type a Media is served with
 * comes off the row. An unknown type gets no extension rather than a guessed one.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType.toLowerCase()] ?? "";
}

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}
