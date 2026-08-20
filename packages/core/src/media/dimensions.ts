/**
 * How wide and how tall an uploaded image is, read out of the bytes themselves.
 *
 * **This is a read, not image processing.** Resizing, format conversion and thumbnails are out
 * of scope by decision — a Project that wants derivatives puts a CDN in front of its
 * `MediaStorage` — and none of that is happening here: each format below states its size in a
 * fixed header, and this walks to it and stops. Nothing is decoded, so a 40 MB photograph costs
 * the same as a favicon.
 *
 * The alternative was to take `width` and `height` as fields on the upload, and it is worse in
 * the way that matters: they would be whatever a client said, so a storefront laying out against
 * them would be laying out against a claim. Read from the header they are a fact about the file,
 * which is why the column is `null` rather than `0` for a format this cannot read — a storefront
 * can tell *unknown* from *nothing* and reserve space only when it really knows.
 *
 * Four formats, which is what a Merchant uploads: PNG, JPEG, GIF and WebP. **SVG is deliberately
 * absent**: it is XML, its `width` may be a percentage or absent entirely, and an intrinsic pixel
 * size is a thing it need not have — `null` is the honest answer and parsing XML to arrive at it
 * would be work spent to say the same thing. AVIF is absent for the opposite reason: its size
 * lives inside an ISO-BMFF box tree, which is a parser rather than an offset, and a format
 * nobody has asked for is not worth one.
 */
export type ImageDimensions = {
  readonly width: number;
  readonly height: number;
};

/**
 * The image's own account of its size, or `null` for bytes this cannot read.
 *
 * `null` covers every uncertainty in one answer — a format not listed, a truncated file, a
 * header that says zero — because the caller does the same thing with all of them: write `null`
 * to the row and let the storefront know it does not know.
 */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found =
    pngDimensions(bytes, view) ??
    gifDimensions(bytes, view) ??
    webpDimensions(bytes, view) ??
    jpegDimensions(bytes, view);

  // A header that states a zero is a header that is wrong, and `0` would reach a storefront as
  // a real measurement. It joins the unreadable ones.
  return found === null || found.width <= 0 || found.height <= 0 ? null : found;
}

/** The eight-byte PNG signature, then a 13-byte `IHDR` whose first two words are the size. */
function pngDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !startsWith(bytes, SIGNATURE)) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** `GIF87a` or `GIF89a`, then the logical screen size as two little-endian shorts. */
function gifDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
  if (bytes.length < 10) return null;
  if (!startsWith(bytes, asciiOf("GIF8"))) return null;
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/**
 * A RIFF container whose form type is `WEBP`, in whichever of the three chunk layouts it used.
 *
 * All three are in the wild and a file may be any of them, so all three are read: `VP8 ` is
 * lossy, `VP8L` is lossless and packs both numbers into 32 bits fourteen at a time, and `VP8X`
 * is the extended header an animated or an alpha-carrying file gets, which states the size minus
 * one in three bytes each.
 */
function webpDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
  if (bytes.length < 30) return null;
  if (!startsWith(bytes, asciiOf("RIFF"))) return null;
  if (!matchesAt(bytes, 8, asciiOf("WEBP"))) return null;

  if (matchesAt(bytes, 12, asciiOf("VP8X"))) {
    return {
      width: threeByteLittleEndian(bytes, 24) + 1,
      height: threeByteLittleEndian(bytes, 27) + 1,
    };
  }

  if (matchesAt(bytes, 12, asciiOf("VP8L"))) {
    const packed = view.getUint32(21, true);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    };
  }

  if (matchesAt(bytes, 12, asciiOf("VP8 "))) {
    // The keyframe's start code, three bytes, and the two dimensions are the fourteen low bits
    // of the shorts after it. A file whose first frame is not a keyframe is not a still image.
    if (!matchesAt(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }

  return null;
}

/**
 * JPEG is the one that has to be walked: a chain of marker segments, each carrying its own
 * length, until one of the frame headers that states the size.
 *
 * The frame markers are `SOF0`–`SOF15` **minus** `0xC4`, `0xC8` and `0xCC`, which are the
 * Huffman table, the reserved extension and the arithmetic-coding table — three markers sitting
 * inside a range that otherwise means *this is the frame*. Reading them as a frame is how a
 * scan of the range alone reports the size of a Huffman table.
 */
function jpegDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let at = 2;
  // A bound rather than `while (true)`: a truncated or lying file must end this loop, and the
  // segment length is the only thing moving it forward.
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;

    // Padding: any number of `0xFF` bytes may sit between segments.
    const marker = bytes[at + 1];
    if (marker === undefined) return null;
    if (marker === 0xff) {
      at += 1;
      continue;
    }

    if (isFrameHeader(marker)) {
      // Inside the segment: two bytes of length, one of precision, then height and width — in
      // that order, which is the one thing about JPEG that catches everybody.
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }

    const length = view.getUint16(at + 2);
    // A segment that claims to be shorter than its own length field would move nowhere, and the
    // loop would sit on it until the bound ran out.
    if (length < 2) return null;
    at += 2 + length;
  }

  return null;
}

function isFrameHeader(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function threeByteLittleEndian(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
}

function asciiOf(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return matchesAt(bytes, 0, prefix);
}

function matchesAt(bytes: Uint8Array, at: number, expected: readonly number[]): boolean {
  return expected.every((byte, offset) => bytes[at + offset] === byte);
}
