import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PERMISSIONS } from "../auth/permissions.ts";
import type { KobaiProjectConfig } from "../config.ts";
import {
  createTestKobai,
  sessionOf,
  signInTestMerchant,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";
import {
  DEFAULT_MEDIA_ACCEPT,
  DEFAULT_MEDIA_DIRECTORY,
  filesystemMediaStorage,
  type MediaStorage,
  type MediaUpload,
} from "./storage.ts";

/**
 * Media, end to end: the multipart route, the record it writes, and the seam a Project
 * substitutes (#254, ADR-0015).
 *
 * **Two seams and one rule.** The dominant one is the HTTP surface as everywhere else; the
 * second is the `MediaStorage` interface itself, and the rule is the one
 * `@kobai/plugin-stripe` already follows — **nothing here reaches a network or a real object
 * store.** Every case either substitutes a storage of its own or points the shipped
 * filesystem one at a directory it made and deletes on the way out. `createTestKobai` does the
 * second for every other test in this repository, which is why none of them writes into the
 * checkout.
 *
 * **Where the substitution cases assert is the point of them.** They ask the substitute what it
 * is *holding* — these exact bytes, under this content type — rather than counting that `put`
 * was reached. That distinction is `payment/payment.test.ts`'s and it is the same one: "the code
 * ran" and "the Merchant's image is in the bucket" are two facts, and a counter only ever knows
 * the first.
 */

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

/** A 2×3 PNG, built from the format's own header rather than checked in as a blob. */
function pngBytes(width = 2, height = 3): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** What a Media reads as on the wire. */
type Media = {
  id: string;
  url: string;
  contentType: string;
  filename: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  alt: string | null;
};

/** Uploads through the public route, exactly as the Admin's form does. */
async function upload(
  harness: TestKobai,
  merchant: { readonly headers: { readonly cookie: string } },
  file: { bytes?: Uint8Array; name?: string; type?: string; alt?: string } = {},
): Promise<Response> {
  const body = new FormData();
  body.set(
    "file",
    new File([file.bytes ?? pngBytes()], file.name ?? "poster.png", {
      type: file.type ?? "image/png",
    }),
  );
  if (file.alt !== undefined) body.set("alt", file.alt);

  // No `content-type` of our own: `FormData` sets one with the boundary it generated, and a
  // hand-written header would be a boundary nothing matches.
  return harness.request("/admin/media", {
    method: "POST",
    headers: merchant.headers,
    body,
  });
}

/**
 * A storage that keeps books, and answers a URL of its own.
 *
 * This is the shape a Store on S3 or a CDN actually writes: `read` returns `null`, meaning *my
 * bytes are not kobai's to serve*, and `urlFor` sends a storefront straight at the CDN. It is
 * one line, which is the claim `MediaStorage` makes about how small an adapter is.
 */
function recordingStorage() {
  const objects = new Map<string, MediaUpload>();
  let written = 0;

  const storage: MediaStorage = {
    put: async (upload) => {
      written += 1;
      // No `/` in it, deliberately: a key is a path segment on kobai's byte route, and one
      // carrying a slash would match no route at all — so the 404 the case below asserts would
      // be `app.notFound`'s rather than this storage's `read` answering `null`, and would pass
      // against a Core that proxied happily. `StoredMedia` says the same thing from the other
      // side.
      const key = `object-${written}`;
      objects.set(key, upload);
      return { key };
    },
    urlFor: (key) => `https://cdn.example.test/${key}`,
    read: async () => null,
  };

  return { objects, storage };
}

describe("uploading Media", () => {
  it("stores the bytes and answers with the record", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await upload(kobai, merchant, { alt: "A blue poster" });

    expect(response.status).toBe(201);
    const media = (await response.json()) as Media;
    expect(media).toEqual({
      id: expect.any(String),
      url: expect.any(String),
      contentType: "image/png",
      filename: "poster.png",
      byteSize: 24,
      // Read out of the PNG's own header rather than taken from the request, which sent
      // neither number — `media/dimensions.ts` is where that is asserted format by format.
      width: 2,
      height: 3,
      alt: "A blue poster",
    });
  });

  it("has no alt text until somebody writes it, and never an empty one", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const none = (await (await upload(kobai, merchant)).json()) as Media;
    const blank = (await (await upload(kobai, merchant, { alt: "   " })).json()) as Media;

    // `null` and `""` are different facts on the wire — a Merchant who has not written it and
    // one who says the image is decorative — and neither of these is the second.
    expect(none.alt).toBeNull();
    expect(blank.alt).toBeNull();
  });

  it("says nothing about the size of a format it cannot measure", async () => {
    // An SVG, so this deployment is one that takes them: Core's default `accept` does not, for
    // the reason on `MediaOptions.accept` — an SVG is a document that may carry script and
    // `GET /media/{key}` is open and same-origin. A Store that wants them says so, which is
    // this line, and that is the whole of what it costs.
    kobai = await createTestKobai({
      media: { accept: ["image/png", "image/svg+xml"] },
    });
    const merchant = await signInTestMerchant(kobai);

    const response = await upload(kobai, merchant, {
      bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      name: "logo.svg",
      type: "image/svg+xml",
    });

    const media = (await response.json()) as Media;
    // `null` rather than `0`: a storefront reserving space would lay out against a zero.
    expect(media).toMatchObject({
      contentType: "image/svg+xml",
      width: null,
      height: null,
    });
  });

  it("refuses an empty file, which no schema can see is empty", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await upload(kobai, merchant, { bytes: new Uint8Array(0) });

    // A perfectly well formed `File` part carrying nothing. Storing it would give a Merchant a
    // Media whose URL serves zero bytes, which they would find out about from their storefront.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("refuses a body with no file part at all", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const body = new FormData();
    body.set("alt", "a poster");

    const response = await kobai.request("/admin/media", {
      method: "POST",
      headers: merchant.headers,
      body,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("is behind catalog:write, and reading Media is behind catalog:read", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const reader = await onARole(kobai, owner, "reader", [PERMISSIONS.catalogRead]);

    const attempted = await upload(kobai, reader);
    const read = await kobai.request("/admin/media", { headers: reader.headers });

    // The write is refused and the read is not, which is the split every family on this
    // surface makes: seeing what a Store has escalates to nothing (ADR-0066). Both halves,
    // because a Role holding nothing would satisfy the first on its own.
    expect(attempted.status).toBe(403);
    await expect(attempted.json()).resolves.toMatchObject({
      reason: "permission-denied",
      required: PERMISSIONS.catalogWrite,
    });
    expect(read.status).toBe(200);
  });

  it("refuses both routes with no session at all", async () => {
    kobai = await createTestKobai();

    const listed = await kobai.request("/admin/media");

    expect(listed.status).toBe(401);
    await expect(listed.json()).resolves.toMatchObject({ reason: "session-missing" });
  });
});

describe("what an upload has to be", () => {
  it("refuses a file over the deployment's ceiling, and stores nothing", async () => {
    const bucket = recordingStorage();
    kobai = await createTestKobai({
      media: { storage: bucket.storage, maxBytes: 64 },
    });
    const merchant = await signInTestMerchant(kobai);

    const response = await upload(kobai, merchant, { bytes: new Uint8Array(65) });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "media-too-large",
    });
    // The half that matters, and the reason this refusal is made before `put` rather than
    // after it: `MediaStorage` has no `remove` (ADR-0078), so bytes written by a request that
    // is then turned back are bytes no route can ever delete.
    expect([...bucket.objects.keys()]).toEqual([]);
  });

  it("refuses a content type this Store does not take, and stores nothing", async () => {
    const bucket = recordingStorage();
    kobai = await createTestKobai({ media: { storage: bucket.storage } });
    const merchant = await signInTestMerchant(kobai);

    // The accident this exists for: a Merchant meant to attach a photograph and attached the
    // archive sitting next to it. Nothing about the request is malformed, which is why it is
    // 422 and not 400 — and the refusal names what this Store does take.
    const response = await upload(kobai, merchant, {
      name: "catalog.zip",
      type: "application/zip",
    });

    expect(response.status).toBe(422);
    const refusal = (await response.json()) as { reason: string; error: string };
    expect(refusal.reason).toBe("content-type-not-accepted");
    expect(refusal.error).toContain("image/png");
    expect([...bucket.objects.keys()]).toEqual([]);
  });

  it("takes what the Project said it takes, and nothing it did not", async () => {
    kobai = await createTestKobai({ media: { accept: ["application/pdf"] } });
    const merchant = await signInTestMerchant(kobai);

    // Naming the key **replaces** Core's list rather than adding to it, which is what wiring a
    // Fulfilment Strategy over one of Core's already means — so this Store takes datasheets
    // and no longer takes the PNG every other case here uploads.
    const datasheet = await upload(kobai, merchant, {
      name: "spec.pdf",
      type: "application/pdf",
    });
    const png = await upload(kobai, merchant);

    expect(datasheet.status).toBe(201);
    await expect(datasheet.json()).resolves.toMatchObject({
      contentType: "application/pdf",
    });
    expect(png.status).toBe(422);
    await expect(png.json()).resolves.toMatchObject({
      reason: "content-type-not-accepted",
    });
  });

  it("refuses a request that declares too much before it reads a byte of it", async () => {
    const bucket = recordingStorage();
    kobai = await createTestKobai({
      media: { storage: bucket.storage, maxBytes: 1024 },
    });
    const merchant = await signInTestMerchant(kobai);

    // **A body that could not be parsed at all**, under a `Content-Length` claiming far more
    // than the ceiling. That pairing is what makes this case able to see where the refusal is
    // made: a request whose body the validator reached is answered `400 invalid` for having no
    // file part in it, so a `422 media-too-large` can only have been decided before the parse.
    // Watching whether the stream was read cannot do the same job — a `Request` constructed
    // in-process pumps its own body whatever the application does with it.
    const response = await kobai.request(
      new Request("http://kobai.test/admin/media", {
        method: "POST",
        headers: {
          ...merchant.headers,
          "content-type": "multipart/form-data; boundary=kobai",
          // What a browser sends before it starts uploading. It is a claim, and this check is
          // the cheap half precisely because it believes one — the honest half is below.
          "content-length": String(64 * 1024 * 1024),
        },
        body: "not a multipart body at all",
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "media-too-large",
    });
    // The whole point: the multipart parser is what puts a file on the heap, so a ceiling
    // enforced behind it bounds what is stored and nothing about what is held.
    expect([...bucket.objects.keys()]).toEqual([]);
  });

  it("still measures what a request will not declare", async () => {
    const bucket = recordingStorage();
    kobai = await createTestKobai({
      media: { storage: bucket.storage, maxBytes: 64 },
    });
    const merchant = await signInTestMerchant(kobai);

    // A chunked upload declares no length at all, so the cheap check has nothing to read and
    // says nothing. This is the case that proves which half of the pair actually decides: the
    // bytes are measured after the parse, and refused before the storage is written.
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(500)], "poster.png", { type: "image/png" }),
    );
    // One `Response`, read twice: it invents the boundary, so a second one would name a
    // boundary the bytes of the first do not carry and nothing would parse.
    const encoded = new Response(form);
    const contentType = encoded.headers.get("content-type") ?? "";
    const streamed = await encoded.arrayBuffer();
    const response = await kobai.request(
      new Request("http://kobai.test/admin/media", {
        method: "POST",
        headers: { ...merchant.headers, "content-type": contentType },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(streamed));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "media-too-large",
    });
    expect([...bucket.objects.keys()]).toEqual([]);
  });

  it("asks whether the Merchant may upload before it asks how big this is", async () => {
    kobai = await createTestKobai({ media: { maxBytes: 64 } });
    const owner = await signInTestMerchant(kobai);
    const reader = await onARole(kobai, owner, "reader", [PERMISSIONS.catalogRead]);

    const response = await upload(kobai, reader, { bytes: new Uint8Array(65) });

    // Both refusals are true of this request, and the Merchant can act on only one of them.
    // Answering the ceiling first would also tell somebody who may not upload at all how big
    // this Store's uploads may be, which is a fact about the deployment they were not given.
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      reason: "permission-denied",
    });
  });

  it("takes a file of exactly the ceiling, envelope and all", async () => {
    kobai = await createTestKobai({ media: { maxBytes: 4096 } });
    const merchant = await signInTestMerchant(kobai);

    // A multipart body is bigger than the file inside it — boundaries, part headers, the `alt`
    // field — so a declared-size check compared exactly against the ceiling would refuse this
    // for bytes that are not the file's. The allowance is what keeps the cheap check from ever
    // turning back something the honest one would take.
    const bytes = new Uint8Array(4096);
    bytes.set(pngBytes());
    const response = await upload(kobai, merchant, { bytes, alt: "A poster" });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ byteSize: 4096 });
  });

  it("reads the declared type the way a browser writes it", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    // Case and parameters are the part header's business, not a Merchant's: both sides of the
    // comparison are normalised, so a difference in either is not a refusal.
    const response = await upload(kobai, merchant, { type: "IMAGE/PNG; charset=binary" });

    expect(response.status).toBe(201);
    // And what the *row* holds is still the header as it arrived — `File` lowercases the type
    // it is given and kobai keeps the parameters — because the record says what the upload
    // declared and only the comparison normalises. The bytes come back as this, with `nosniff`.
    await expect(response.json()).resolves.toMatchObject({
      contentType: "image/png; charset=binary",
    });
  });
});

/**
 * **A `media` key Core cannot serve stops the boot**, which is `session.idleWindowMs`'s
 * judgement and `reservations.holdWindowMs`'s (ADR-0050, ADR-0075) reached at a third key of the
 * same file.
 *
 * The seam is `createTestKobai`, which is `createKobai` with a database in front of it, so these
 * assert what a Project's `server.ts` does on the way up. **Nothing is clamped**: a deployment
 * whose ceiling is quietly something other than what its config file says is worse than one that
 * refuses to start, and a Developer who wrote the number is the person reading the message.
 *
 * There is deliberately **no upper bound** on `maxBytes`, which is why the last case exists: a
 * suite that only ever asked for modest numbers would pass just as happily against a ceiling
 * somebody added later, and what a large one costs is this deployment's own memory and its own
 * storage bill.
 */
describe("a media policy Core will not enforce", () => {
  it("refuses a ceiling of zero, which is a route that takes nothing", async () => {
    await expect(createTestKobai({ media: { maxBytes: 0 } })).rejects.toThrow(
      /`media\.maxBytes`.*at least 1/s,
    );
  });

  it("refuses a ceiling that is not a whole number of bytes", async () => {
    // `Number(process.env.KOBAI_MEDIA_MAX_BYTES)` with the variable unset is `NaN`, and it
    // typechecks as a `number` the whole way in.
    await expect(
      createTestKobai({ media: { maxBytes: Number("nonsense") } }),
    ).rejects.toThrow(/`media\.maxBytes`.*whole number of bytes.*NaN/s);
  });

  it("refuses an empty accepted set, which is the same route by another route", async () => {
    await expect(createTestKobai({ media: { accept: [] } })).rejects.toThrow(
      /`media\.accept`.*empty/s,
    );
  });

  it("refuses an accepted set naming something that is not a content type", async () => {
    await expect(
      createTestKobai({ media: { accept: ["image/png", "  "] } }),
    ).rejects.toThrow(/`media\.accept`.*" {2}"/s);
  });

  it("takes a ceiling far above anything Core would have chosen, and says so", async () => {
    // Two gigabytes, which is a Store on an object store making a trade Core has no standing
    // to refuse — the bound is that deployment's memory and its own bill.
    const maxBytes = 2 * 1024 ** 3;
    await using booted = await createTestKobai({
      media: { maxBytes, accept: ["image/avif"] },
    });

    // And the *description* this instance serves carries both, which is `Session`'s idle
    // window one route along: what a Store takes is a fact about the deployment, so a
    // Developer reading `GET /admin/openapi.json` reads their own numbers rather than kobai's.
    expect(uploadDescription(booted)).toContain(`up to ${maxBytes} bytes`);
    expect(uploadDescription(booted)).toContain("`image/avif`");
    expect(uploadDescription(booted)).not.toContain("image/png");
  });
});

/** What this instance's own OpenAPI description says `POST /admin/media` takes. */
function uploadDescription(harness: TestKobai): string {
  const description = harness.openapi().paths?.["/admin/media"]?.post?.description;
  if (typeof description !== "string") {
    throw new Error("The description carries no POST /admin/media to read.");
  }
  return description;
}

describe("where the bytes come from", () => {
  it("serves what was uploaded, at the address the Media reported", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const bytes = pngBytes(120, 60);

    const media = (await (await upload(kobai, merchant, { bytes })).json()) as Media;
    const served = await kobai.request(media.url);

    // The whole round trip, over the address the API answered with rather than one this test
    // built — a `url` a client cannot fetch is the failure this route exists to prevent.
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  });

  it("is open, because an `<img>` carries no credential", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const media = (await (await upload(kobai, merchant)).json()) as Media;

    // No session, no API key — the request a browser actually makes for an image. This is the
    // one route on the surface that answers one, and `http/app.ts` argues why.
    const served = await kobai.request(media.url, { headers: {} });

    expect(served.status).toBe(200);
  });

  it("refuses to guess what the bytes are", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const media = (await (await upload(kobai, merchant)).json()) as Media;

    const served = await kobai.request(media.url);

    // The route serves whatever a Merchant uploaded, so a browser sniffing it into `text/html`
    // would be a stored script on the Store's own origin.
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers media-not-found for a key nothing was stored under", async () => {
    kobai = await createTestKobai();

    const served = await kobai.request("/media/nothing-was-stored-here.png");

    expect(served.status).toBe(404);
    await expect(served.json()).resolves.toMatchObject({ reason: "media-not-found" });
  });

  it("does not read a path out of the key it is handed", async () => {
    kobai = await createTestKobai();

    // A row is looked up first, so this can reach the filesystem storage only if something
    // above it went badly wrong — which is exactly why the storage refuses the shape as well.
    const escaped = await kobai.request("/media/..%2F..%2Fpackage.json");

    expect(escaped.status).toBe(404);
  });
});

describe("a MediaStorage a Project substituted", () => {
  it("is handed the bytes, and is what the Store is then holding", async () => {
    const bucket = recordingStorage();
    kobai = await createTestKobai({ media: { storage: bucket.storage } });
    const merchant = await signInTestMerchant(kobai);
    const bytes = pngBytes(800, 600);

    const response = await upload(kobai, merchant, {
      bytes,
      name: "hero.png",
      type: "image/png",
    });

    expect(response.status).toBe(201);
    // The acceptance for the interface half: ask the substitute what it is holding. A counter
    // saying `put` was called would pass against a Core that stored the bytes itself and
    // reached for the storage afterwards.
    expect([...bucket.objects.keys()]).toEqual(["object-1"]);
    expect(bucket.objects.get("object-1")).toEqual({
      filename: "hero.png",
      contentType: "image/png",
      bytes,
    });
  });

  it("decides the address, and kobai never proxies its bytes", async () => {
    const bucket = recordingStorage();
    kobai = await createTestKobai({ media: { storage: bucket.storage } });
    const merchant = await signInTestMerchant(kobai);

    const media = (await (await upload(kobai, merchant)).json()) as Media;

    // The storage's own answer, verbatim: a Store behind a CDN sends storefronts there and no
    // image byte passes through this process. That is the read-path decision, asserted.
    expect(media.url).toBe("https://cdn.example.test/object-1");
    // And the byte route says so rather than fetching them on the storefront's behalf: this
    // storage's `read` answers `null`, which means *not kobai's to serve*. The `reason` is
    // asserted rather than only the status, because an unrouted path is a 404 too — and that
    // one would pass against a Core that never asked the storage at all.
    const proxied = await kobai.request("/media/object-1");
    expect(proxied.status).toBe(404);
    await expect(proxied.json()).resolves.toMatchObject({ reason: "media-not-found" });
  });

  it("is asked again on every read, so a Store that moves its bucket moves every Media", async () => {
    const bucket = recordingStorage();
    // A storage whose answer can change under a running Store, which is the cheapest way to
    // ask the question this test is about: *is the address stored, or asked for?* A `url`
    // column would have been written at upload and would still say `cdn` below.
    let host = "https://cdn.example.test";
    kobai = await createTestKobai({
      media: { storage: { ...bucket.storage, urlFor: (key) => `${host}/${key}` } },
    });
    const merchant = await signInTestMerchant(kobai);
    const uploaded = (await (await upload(kobai, merchant)).json()) as Media;
    expect(uploaded.url).toBe("https://cdn.example.test/object-1");

    host = "https://images.example.test";
    const page = (await (
      await kobai.request("/admin/media", { headers: merchant.headers })
    ).json()) as { media: Media[] };

    // Nothing rewrote a row: the record holds the storage key and the storage holds the
    // address, which is the one edit a Store putting a CDN in front of its bucket has to make.
    expect(page.media.map((one) => one.url)).toEqual([
      "https://images.example.test/object-1",
    ]);
  });
});

describe("the storage kobai ships", () => {
  it("writes into the directory it was given and nowhere else", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kobai-media-case-"));
    try {
      kobai = await createTestKobai({
        media: { storage: filesystemMediaStorage({ directory }) },
      });
      const merchant = await signInTestMerchant(kobai);
      const bytes = pngBytes(10, 20);

      await upload(kobai, merchant, { bytes });

      // The file itself, on disk, with the bytes that were uploaded — not a claim that a write
      // was attempted. This is the whole of what "a Store with no object store still works"
      // means, and it is the one case that can see it.
      const written = await readdir(directory);
      expect(written).toHaveLength(1);
      const [only] = written;
      expect(new Uint8Array(await readFile(join(directory, only ?? "")))).toEqual(bytes);
      // The name is kobai's own and carries nothing a caller sent: a filename from a browser
      // is whatever an operating system said, and building a path out of one is how `../..`
      // reaches a write.
      expect(only).toMatch(/^[0-9a-f-]{36}\.png$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("is still what a test gets when the test configured something else about Media", async () => {
    // `media` is a subject with three keys, so a test naming one of the other two is saying
    // nothing about where bytes go — and a harness that replaced the whole subject would hand
    // it the shipped storage's *default* directory, which is `kobai-media/` under the process's
    // working directory and so inside this checkout. That is #254's finding arriving through a
    // new door: `.gitignore` keeps such a directory out of `git status`, and
    // `packages/create-kobai/src/tree.ts` reads no ignore file, so the first thing to notice
    // would have been a PNG in the template every Developer receives.
    kobai = await createTestKobai({ media: { maxBytes: 4096 } });
    const merchant = await signInTestMerchant(kobai);

    expect((await upload(kobai, merchant)).status).toBe(201);
    expect(
      existsSync(resolve(DEFAULT_MEDIA_DIRECTORY)),
      `the suite wrote uploads into ${resolve(DEFAULT_MEDIA_DIRECTORY)}`,
    ).toBe(false);
  });

  it("names a file for every content type Core accepts by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kobai-media-case-"));
    try {
      const storage = filesystemMediaStorage({ directory });

      // The tie between the two lists in `storage.ts`, asserted rather than asserted *about*:
      // `DEFAULT_MEDIA_ACCEPT` is a policy and `EXTENSIONS` is a convenience, and a doc comment
      // saying they agree is exactly the kind of claim that stops being true when one of them
      // gains an entry. What this holds is the property a Developer notices — a file they can
      // open by double-clicking it — and nothing about the byte route, which reads the content
      // type off the row and never off the name.
      for (const contentType of DEFAULT_MEDIA_ACCEPT) {
        const stored = await storage.put({
          filename: "poster",
          contentType,
          bytes: pngBytes(),
        });
        expect(
          stored.key,
          `the shipped storage named no file for ${contentType}`,
        ).toMatch(/\.[a-z0-9]+$/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads nothing outside its directory, whatever key it is handed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kobai-media-case-"));
    try {
      const storage = filesystemMediaStorage({ directory });

      // Asked directly rather than through the route, because the route looks a row up first
      // and so can never send one of these — which is exactly why the storage has to refuse
      // them itself, for the day some other caller is less careful.
      await expect(storage.read("../../package.json")).resolves.toBeNull();
      await expect(storage.read("/etc/hosts")).resolves.toBeNull();
      await expect(storage.read("..")).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * **What the compiler refuses to let a Project wire as a `MediaStorage`.**
 *
 * Written against {@link KobaiProjectConfig} rather than against `MediaStorage` alone, the way
 * `fulfilment.test.ts` and `config.test.ts` write theirs: the promise is kept at the shape of
 * the file a Developer actually edits, and a substitute that satisfies the interface in
 * isolation and not there would be a promise kept in the wrong place.
 *
 * They are run by the `typecheck` step of the gate rather than by vitest. The `expect` below
 * each only keeps the block a test; the assertion is the `@ts-expect-error`, which fails the
 * build if the line it marks ever compiles.
 */
describe("what a Project could not have wired as a MediaStorage", () => {
  it("rejects a storage that demands more of an upload than Core sends", () => {
    // Contravariance, and the whole reason every operation here is a function-valued property
    // rather than a method. This is the plausible mistake — an adapter that wants to lay its
    // objects out per Product — and under the method spelling it would compile and then read
    // `.productId` off an object Core never puts one on.
    const perProduct: KobaiProjectConfig = {
      media: {
        storage: {
          // @ts-expect-error Core has no Product at upload: attaching one is a separate act.
          put: async (upload: MediaUpload & { productId: string }) => ({
            key: `${upload.productId}/1`,
          }),
          urlFor: (key) => key,
          read: async () => null,
        },
      },
    };

    expect(perProduct).toBeDefined();
  });

  it("rejects a storage that leaves out an operation Core calls", () => {
    const partial: KobaiProjectConfig = {
      media: {
        // @ts-expect-error `read` is required — a storage whose bytes kobai does not serve
        // answers `null` from it, which is one line and states the decision.
        storage: {
          put: async () => ({ key: "one" }),
          urlFor: (key) => key,
        },
      },
    };

    expect(partial).toBeDefined();
  });

  it("takes the smallest storage that answers what Core asks", () => {
    // The other half, and the claim the interface makes about how small an adapter is: three
    // properties, and a `read` that says these bytes are not kobai's to serve.
    const cdn: MediaStorage = {
      put: async ({ filename }) => ({ key: `objects/${filename}` }),
      urlFor: (key) => `https://cdn.example.test/${key}`,
      read: async () => null,
    };

    expect([cdn, filesystemMediaStorage()]).toBeDefined();
  });
});

/**
 * A second Merchant on a Role holding exactly the Permissions named.
 *
 * Through `POST /admin/roles` and `POST /admin/merchants`, which is the only way there is —
 * a Role built with SQL is not the surface a Merchant uses, so a test that built one would
 * pass just as well against a route that is broken or gated wrongly, and
 * `tests/a-role-is-made-through-the-route.test.ts` fails the build on one.
 */
async function onARole(
  harness: TestKobai,
  owner: TestSession,
  name: string,
  permissions: readonly string[],
): Promise<Pick<TestSession, "headers" | "token">> {
  const headers = { ...owner.headers, "content-type": "application/json" };
  const email = `${name}@example.test`;
  const password = "a colleague's very long password";

  const role = await harness.request("/admin/roles", {
    method: "POST",
    headers,
    body: JSON.stringify({ name, permissions }),
  });
  expect(role.status, `creating the ${name} Role`).toBe(201);

  const colleague = await harness.request("/admin/merchants", {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password, role: name }),
  });
  expect(colleague.status, `creating the ${name} Merchant`).toBe(201);

  return sessionOf(
    await harness.request("/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
}
