import { describe, expect, it } from "vitest";
import { imageDimensions } from "./dimensions.ts";

/**
 * Reading an image's own account of its size out of its header.
 *
 * **The fixtures are the point of this file.** Each one is a real file of the format, built
 * byte by byte here rather than checked in as a blob, so the expected numbers come from the
 * format's own specification rather than from running this code and writing down what it said —
 * which is the tautology a snapshot of a parser always is. Every width and height below is a
 * number a person chose and then encoded by hand, and the two are visibly different things in
 * each fixture.
 *
 * They are also **as small as the format allows**, which is why they can be literals at all:
 * nothing here decodes an image, so a header and a plausible trailer is a file as far as this
 * module is concerned. Where a fixture is deliberately truncated or lying, it says so.
 */

/** A PNG: the eight-byte signature, an `IHDR` chunk length and tag, then width and height. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // the IHDR chunk's length, which is always 13
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A GIF: `GIF89a`, then the logical screen size as little-endian shorts. */
function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set(
    [..."GIF89a"].map((c) => c.charCodeAt(0)),
    0,
  );
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

/**
 * A JPEG: `SOI`, then a segment to be skipped over, then the `SOF0` frame header.
 *
 * The segment in the middle is what makes this a walk rather than a fixed offset, and it is a
 * `DHT` — marker `0xC4`, which sits *inside* the `SOF0`–`SOF15` range and is not a frame. A
 * reader that took the whole range would read this table's own bytes as a size.
 */
function jpeg(width: number, height: number): Uint8Array {
  const table = [0xff, 0xc4, 0x00, 0x06, 0x11, 0x22, 0x33, 0x44];
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08];
  const bytes = new Uint8Array([
    0xff,
    0xd8,
    ...table,
    ...frame,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    // The rest of the frame header — component counts and so on — which nothing here reads and
    // a real file always has.
    0x03,
    0x01,
    0x22,
    0x00,
  ]);
  return bytes;
}

/** A lossy WebP: a RIFF container, form `WEBP`, a `VP8 ` chunk with a keyframe start code. */
function webpLossy(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  const ascii = (text: string, at: number) => {
    bytes.set(
      [...text].map((c) => c.charCodeAt(0)),
      at,
    );
  };
  ascii("RIFF", 0);
  ascii("WEBP", 8);
  ascii("VP8 ", 12);
  bytes.set([0x9d, 0x01, 0x2a], 23); // the keyframe start code
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

/** An extended WebP: the `VP8X` chunk, which states each dimension **minus one**, in 24 bits. */
function webpExtended(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  const ascii = (text: string, at: number) => {
    bytes.set(
      [...text].map((c) => c.charCodeAt(0)),
      at,
    );
  };
  ascii("RIFF", 0);
  ascii("WEBP", 8);
  ascii("VP8X", 12);
  const write24 = (value: number, at: number) => {
    bytes.set([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff], at);
  };
  write24(width - 1, 24);
  write24(height - 1, 27);
  return bytes;
}

describe("the size an image states about itself", () => {
  it("reads a PNG's IHDR", () => {
    expect(imageDimensions(png(1200, 630))).toEqual({ width: 1200, height: 630 });
  });

  it("reads a GIF's logical screen", () => {
    expect(imageDimensions(gif(48, 96))).toEqual({ width: 48, height: 96 });
  });

  it("walks a JPEG's segments to its frame header, past a table in the same marker range", () => {
    // The one case where a plausible implementation is wrong rather than absent: `0xC4` is a
    // Huffman table and lives between `SOF0` and `SOF15`, so a reader that scanned the range
    // would answer 0x1122 × 0x3344 from the table's own bytes.
    expect(imageDimensions(jpeg(800, 1200))).toEqual({ width: 800, height: 1200 });
  });

  it("does not read a JPEG's height as its width", () => {
    // JPEG states height first, which is the one thing about this format everybody gets wrong
    // — and a square fixture would pass either way, so this one is deliberately not square.
    expect(imageDimensions(jpeg(100, 200))).toEqual({ width: 100, height: 200 });
  });

  it("reads a lossy WebP", () => {
    expect(imageDimensions(webpLossy(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("reads an extended WebP, which states one less than the truth", () => {
    // The `VP8X` chunk stores `width - 1`, so an implementation that forgot the `+ 1` is off by
    // exactly one and every other case in this file would still pass.
    expect(imageDimensions(webpExtended(1024, 768))).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it("says nothing about a format it cannot read", () => {
    // An SVG is an image and has no intrinsic pixel size to state, so `null` is the answer
    // rather than a number invented for it.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

    expect(imageDimensions(svg)).toBeNull();
  });

  it("says nothing about bytes that are not an image at all", () => {
    expect(imageDimensions(new TextEncoder().encode("hello"))).toBeNull();
  });

  it("says nothing about a truncated header", () => {
    // A PNG signature and then nothing: a reader that took the bytes on trust would read past
    // the end and answer whatever a `DataView` throws or zero.
    expect(
      imageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBeNull();
  });

  it("says nothing where the header states a zero", () => {
    // A header that is readable and wrong. `0` would otherwise reach a storefront as a real
    // measurement, and it would lay out against it.
    expect(imageDimensions(png(0, 630))).toBeNull();
  });

  it("does not loop on a JPEG whose segment lengths go nowhere", () => {
    // A segment claiming to be shorter than its own length field would advance the walk by a
    // negative amount, and a file of them is a request that never returns.
    const lying = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00]);

    expect(imageDimensions(lying)).toBeNull();
  });
});
