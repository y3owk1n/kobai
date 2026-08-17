import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * Core and every Plugin apply migrations from a `migrations/` directory resolved relative
 * to their *built* output — `new URL("../../migrations", import.meta.url)` from `dist/`,
 * which is the package root. Nothing in the source tree proves that directory is inside
 * the tarball a Project installs. `files` in each manifest says it should be, and a
 * manifest is a promise, not a receipt.
 *
 * If it ever stops shipping, Core and every Plugin break at a Developer's `install` — the
 * first thing anyone does — with no failing test anywhere. The prototype listed exactly
 * this under "Not tested": branch `prototype/drizzle-multi-migration`, FINDINGS.md.
 *
 * So this packs each table-owning package for real and reads the bytes back out.
 */
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

/** The directory each package generates into, names in `files`, and resolves at runtime. */
const MIGRATIONS = "migrations";
/** What Drizzle reads first: no journal, no migrations, however many `.sql` files ship. */
const JOURNAL = `${MIGRATIONS}/meta/_journal.json`;
/** npm roots every tarball here, whatever the package is called. */
const TARBALL_ROOT = "package/";

/** A package that owns tables, and therefore ships migrations a Project must receive. */
type TableOwningPackage = {
  /** The npm name, so a failure says which package. */
  readonly name: string;
  /** Absolute path to the package directory — where `pnpm pack` runs. */
  readonly directory: string;
  /** Paths, relative to the package root, the tarball has to carry. */
  readonly required: readonly string[];
};

/**
 * Every workspace package that owns tables, discovered rather than listed.
 *
 * A hardcoded list of the two packages that exist today would stop covering everything on
 * the day the next Plugin lands, and would do it silently — which is the failure this test
 * exists to prevent, one level up. Two signals count, and either is enough: a package that
 * has a `migrations/` directory, and a package whose manifest promises one in `files`. The
 * union matters because the interesting bugs live where the two disagree — a directory
 * dropped from `files` packs nothing, and a `files` entry with no directory behind it
 * ships nothing.
 *
 * The workspace itself comes from pnpm, so `pnpm-workspace.yaml` stays the single place
 * packages are declared.
 */
async function tableOwningPackages(): Promise<TableOwningPackage[]> {
  const found: TableOwningPackage[] = [];

  for (const { name, path } of await workspacePackages()) {
    const declared = (await manifestFiles(path)).includes(MIGRATIONS);
    if (!declared && !(await isDirectory(join(path, MIGRATIONS)))) continue;

    found.push({ name, directory: path, required: await requiredOf(path) });
  }

  if (found.length === 0) {
    // Failing open would be worse than failing: an empty list makes this whole file pass
    // by checking nothing, which is indistinguishable from checking everything.
    throw new Error(
      `No workspace package was found to own tables, so no tarball was checked. Core always does — look at how ${repoRoot} enumerates its workspace.`,
    );
  }

  return found;
}

/**
 * pnpm, spawned from `PATH`.
 *
 * AGENTS.md § Development says every Node command goes through devbox, and this obeys it
 * transitively: the suite is already running inside `devbox run`, so the child inherits the
 * same pinned toolchain. Somewhere it is not, the failure would otherwise be a bare
 * `spawn pnpm ENOENT`, which says nothing about why.
 */
async function pnpm(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run("pnpm", args, { cwd });
    return stdout;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `\`pnpm ${args.join(" ")}\` could not run because pnpm is not on PATH. Run the suite through devbox — see AGENTS.md § Development.`,
        { cause },
      );
    }
    throw cause;
  }
}

/** The workspace as pnpm sees it, root package included (it owns no tables and drops out). */
async function workspacePackages(): Promise<{ name: string; path: string }[]> {
  const listed = await pnpm(["list", "--recursive", "--depth", "-1", "--json"], repoRoot);
  return JSON.parse(listed) as { name: string; path: string }[];
}

async function manifestFiles(directory: string): Promise<string[]> {
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  ) as { files?: string[] };
  return manifest.files ?? [];
}

/**
 * What this package's tarball has to carry: its journal, and one `.sql` per entry in it.
 *
 * Taken from the journal rather than from a directory listing because the journal is what
 * the runner reads — a `.sql` it names and the tarball lacks is a migration that throws at
 * a Developer's first boot, and a file the journal never names is not applied at all.
 *
 * An unreadable journal leaves the journal itself required, so a package that promises
 * `migrations` in `files` and has generated none fails here rather than passing vacuously.
 * A journal that is readable and empty requires only itself, which is right: a package
 * mid-build with no migrations yet has nothing a tarball could drop.
 */
async function requiredOf(directory: string): Promise<string[]> {
  return [
    JOURNAL,
    ...(await journalTags(directory)).map((tag) => `${MIGRATIONS}/${tag}.sql`),
  ];
}

async function journalTags(directory: string): Promise<string[]> {
  const journal = await readFile(join(directory, JOURNAL), "utf8").catch(() => null);
  if (journal === null) return [];

  const { entries } = JSON.parse(journal) as { entries?: { tag?: string }[] };
  return (entries ?? []).flatMap(({ tag }) => (tag === undefined ? [] : [tag]));
}

async function isDirectory(path: string): Promise<boolean> {
  const entry = await stat(path).catch(() => null);
  return entry?.isDirectory() ?? false;
}

/**
 * Every path inside the tarball `pnpm pack` produces for this package.
 *
 * `pnpm pack` and not a publish: this asks what the package *contains*, which needs no
 * registry, no credentials, and no answer to the separate question of whether these
 * packages should stop being `private: true`.
 */
async function entriesOfPackedTarball(pkg: TableOwningPackage): Promise<string[]> {
  const destination = await mkdtemp(join(tmpdir(), "kobai-pack-"));
  try {
    await pnpm(["pack", "--pack-destination", destination], pkg.directory);

    // The directory was made empty a line ago, so anything but one tarball means `pnpm
    // pack` did something this no longer understands.
    const written = await readdir(destination);
    const [tarball] = written;
    if (written.length !== 1 || tarball === undefined) {
      throw new Error(
        `Packing ${pkg.name} should have written one tarball, but wrote ${written.length}: ${written.join(", ")}`,
      );
    }

    try {
      return tarballEntries(await readFile(join(destination, tarball)));
    } catch (cause) {
      // Every other failure here is reported per package; this one would not be.
      throw new Error(`Could not read the tarball packed for ${pkg.name}.`, { cause });
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

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

/**
 * The paths held in a gzipped tar, read from the bytes rather than through the `tar`
 * binary — whose flags and output differ between the GNU one on CI and the BSD one on a
 * Developer's Mac.
 */
function tarballEntries(archive: Buffer): string[] {
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
      // reporting a file as absent — the one way this check could lie.
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

/**
 * Every required file the tarball does not carry, each already labelled with its package —
 * so a failure reads as `@kobai/core: migrations/meta/_journal.json` rather than as a diff
 * between two long lists of paths.
 */
function missingFromTarball(
  pkg: Pick<TableOwningPackage, "name" | "required">,
  entries: readonly string[],
): string[] {
  const carried = new Set(entries);
  return pkg.required
    .filter((path) => !carried.has(`${TARBALL_ROOT}${path}`))
    .map((path) => `${pkg.name}: ${path}`);
}

/**
 * Packing shells out to pnpm once per package. That is seconds rather than milliseconds,
 * and slower on a cold CI runner than on a warm laptop, so this is generous on purpose: a
 * packaging check that flakes on time gets disabled, and then it guards nothing.
 */
const PACK_TIMEOUT = 180_000;

describe("a packed tarball carries the package's migrations", () => {
  it(
    "holds for every package in the workspace that ships migrations",
    async () => {
      const packages = await tableOwningPackages();

      const missing = await Promise.all(
        packages.map(async (pkg) =>
          missingFromTarball(pkg, await entriesOfPackedTarball(pkg)),
        ),
      );

      expect(missing.flat()).toEqual([]);
    },
    PACK_TIMEOUT,
  );

  // Packs nothing, so the suite-wide timeout is plenty.
  it("discovers Core, which owns tables by definition", async () => {
    // Not a list of what to check — that list is discovered, and grows by itself. This is
    // the one membership that can never stop being true: Core owns the tables ADR-0004
    // closes to Plugins. Discovery finding nothing at all already throws; this catches the
    // narrower slip of discovery finding something and no longer finding Core.
    expect((await tableOwningPackages()).map((pkg) => pkg.name)).toContain("@kobai/core");
  });
});

/**
 * The check above is only as good as its reading of a tarball, and a tarball that is fine
 * today cannot demonstrate the failure. These drive the reporting against listings written
 * to offend, through the same function the real check reports with.
 */
describe("reporting what a tarball left behind", () => {
  const core = {
    name: "@kobai/core",
    required: [JOURNAL, `${MIGRATIONS}/0000_right_expediter.sql`],
  };

  it("finds nothing missing when the tarball carries every required file", () => {
    expect(
      missingFromTarball(core, [
        "package/package.json",
        "package/dist/index.js",
        "package/migrations/0000_right_expediter.sql",
        "package/migrations/meta/_journal.json",
      ]),
    ).toEqual([]);
  });

  it("names the package and every file the tarball left behind", () => {
    expect(
      missingFromTarball(core, ["package/package.json", "package/dist/index.js"]),
    ).toEqual([
      "@kobai/core: migrations/meta/_journal.json",
      "@kobai/core: migrations/0000_right_expediter.sql",
    ]);
  });

  it("fails a tarball holding the migrations somewhere a Project will not look", () => {
    // `files: ["src/migrations"]` would pack the SQL and still leave the runner resolving
    // `<package root>/migrations` and finding nothing.
    expect(
      missingFromTarball(core, [
        "package/src/migrations/0000_right_expediter.sql",
        "package/src/migrations/meta/_journal.json",
      ]),
    ).toHaveLength(2);
  });
});
