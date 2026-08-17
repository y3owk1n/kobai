import { gunzipSync } from "node:zlib";

/**
 * Reading the paths out of a packed npm tarball.
 *
 * Two guardrails need this and they ask different questions of it — whether Core and every
 * Plugin ship their `migrations/`, and whether `create-kobai` ships every file of the
 * Project it generates. Both questions are the same question underneath: **a `files` entry
 * is a promise, and a tarball is the receipt.** One reader, so the two cannot disagree about
 * what a tarball contains.
 *
 * Read from the bytes rather than through the `tar` binary, whose flags and output differ
 * between the GNU one on CI and the BSD one on a Developer's Mac.
 */

/** A tar is a sequence of these, headers and file data alike. */
const BLOCK = 512;
/** The USTAR header layout, as `[offset, length]` — POSIX.1-1988, and unchanged since. */
const HEADER = {
  name: [0, 100],
  /** Octal, and the only field that has to be right: it says where the next header is. */
  size: [124, 12],
  typeFlag: [156, 1],
  /** A path too long for `name` is split, with everything up to the last `/` landing here. */
  prefix: [345, 155],
} as const;

/** npm roots every tarball here, whatever the package is called. */
export const TARBALL_ROOT = "package/";

export function tarballEntries(archive: Buffer): string[] {
  const tar = gunzipSync(archive);
  const entries: string[] = [];

  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    const name = field(header, HEADER.name);
    if (name === "") break; // A zeroed block ends the archive.

    const type = field(header, HEADER.typeFlag);
    if (type === "L" || type === "K" || type === "x" || type === "g") {
      // These carry the real path in a following block instead of in the header. Nothing
      // packed from this repository needs one, and guessing wrong would mean silently
      // reporting a file as absent — the one way this reader could lie.
      throw new Error(
        `Tar entry "${name}" is an extended header of type "${type}", which this reader does not decode.`,
      );
    }

    const size = Number.parseInt(field(header, HEADER.size) || "0", 8);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`Tar entry "${name}" declares an unreadable size.`);
    }

    const prefix = field(header, HEADER.prefix);
    entries.push(prefix === "" ? name : `${prefix}/${name}`);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }

  return entries;
}

/** One NUL-terminated, space-padded tar header field. */
function field(header: Buffer, [start, length]: readonly [number, number]): string {
  const raw = header.subarray(start, start + length).toString("utf8");
  const end = raw.indexOf("\0");
  return (end === -1 ? raw : raw.slice(0, end)).trim();
}
