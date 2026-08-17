import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@kobai/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devOnlyDependencies } from "./support/build-tooling.ts";
import {
  type BuiltImage,
  buildImage,
  databaseUrlForContainer,
  startContainer,
} from "./support/container.ts";

/**
 * The image `devbox run up` builds, inspected as an image rather than read as a Dockerfile.
 *
 * The distinction is the whole reason this file exists. `pnpm install --prod` sat in the
 * runtime stage of both Dockerfiles, looking exactly like the thing that drops
 * devDependencies, and it is not: run over an existing `node_modules` it rewrites the
 * symlink farm and leaves `node_modules/.pnpm` — every devDependency's bytes — untouched. It
 * relinks; it does not prune. So `drizzle-kit`, `vitest`, `biome`, `typescript`, React, Vite
 * and Tailwind all shipped to production, 933 MB of image against 384 KB of built Admin, and
 * no reading of the file said so (#12).
 *
 * Two things follow, and this file does both. The image is asked what it contains, and the
 * image is booted against a real Postgres and made to serve — because a pruning that removed
 * something the runtime needs would otherwise be indistinguishable from a pruning that
 * worked. Core's and each Plugin's `migrations/` are the specific thing at risk:
 * `tests/packaged-migrations.test.ts` proves they survive *packing*, which is a different
 * path from this one.
 */

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** A build, an inspection, a boot and a handful of requests, on a cold runner. */
const IMAGE_TIMEOUT = 900_000;

/**
 * What `/repo` may weigh in the image, in kilobytes.
 *
 * A tripwire, not a target: it was 513 MB when this was written and is now 36 MB, so a
 * limit here catches the whole class of regression — anything that puts the dependency
 * store back — without failing on the megabyte a new production dependency adds. The
 * number is deliberately far from both.
 */
const RUNTIME_TREE_BUDGET_KB = 150_000;

/** The build tools #12 named, each measured in the 933 MB image it was filed against. */
const BUILD_TOOLS_THE_TICKET_NAMED = [
  "drizzle-kit",
  "vitest",
  "@biomejs/biome",
  "typescript",
];

let image: BuiltImage;
let database: TestDatabase;

beforeAll(async () => {
  // Unique per run so two checkouts building the gate at once cannot overwrite each other's
  // image out from under the assertions below.
  image = await buildImage({
    tag: `kobai-gate-runtime:${randomBytes(6).toString("hex")}`,
    context: repoRoot,
    dockerfile: join(repoRoot, "Dockerfile"),
  });
  database = await createTestDatabase();
}, IMAGE_TIMEOUT);

afterAll(async () => {
  await database?.drop();
  await image?.remove();
});

describe("the image the repository ships", () => {
  it(
    "installs no devDependency",
    async () => {
      const forbidden = await devOnlyDependencies();

      // The derivation subtracts the production closure from every declared devDependency,
      // so a bug in it fails *open* — an empty list would make the assertion below pass by
      // checking nothing. The four #12 measured are what it has to contain at minimum.
      expect(forbidden).toEqual(expect.arrayContaining(BUILD_TOOLS_THE_TICKET_NAMED));

      await expect(
        image.installs(forbidden),
        "These are build tools, and they are in the runtime image. `pnpm install --prod` in the runtime stage does not remove them — it relinks over `node_modules/.pnpm` and leaves every byte where it was. The prune has to happen in the build stage, before anything is copied out of it. See the Dockerfile and #12.",
      ).resolves.toEqual([]);
    },
    IMAGE_TIMEOUT,
  );

  it(
    "keeps the runtime tree within its budget",
    async () => {
      const kilobytes = await image.kilobytesOf("/repo");

      expect(
        kilobytes,
        `/repo is ${Math.round(kilobytes / 1024)} MB in the image. It was 513 MB before #12 pruned it and 36 MB after, so this is the dependency store coming back rather than a dependency being added.`,
      ).toBeLessThan(RUNTIME_TREE_BUDGET_KB);
    },
    IMAGE_TIMEOUT,
  );

  it(
    "still carries every migration set a boot has to apply",
    async () => {
      // Discovered rather than listed, for the reason `tests/packaged-migrations.test.ts`
      // discovers them: a hardcoded pair stops covering everything on the day the next
      // Plugin lands, and does it silently.
      const owners = await migrationOwners();
      expect(owners.length).toBeGreaterThan(1);

      const missing: string[] = [];
      for (const owner of owners) {
        const shipped = await image.list(`${owner.pathInImage}/*.sql`);
        for (const file of owner.sqlFiles) {
          if (!shipped.some((path) => path.endsWith(`/${file}`))) {
            missing.push(`${owner.name}: ${file}`);
          }
        }
      }

      expect(
        missing,
        "A migration the journal names is not in the image, so this container boots into a database it cannot finish migrating. Whatever the runtime stage prunes, `migrations/` is not it.",
      ).toEqual([]);
    },
    IMAGE_TIMEOUT,
  );

  it(
    "ships the Admin as built bytes and not as source",
    async () => {
      await expect(image.has("/repo/reference/admin/dist/index.html")).resolves.toBe(
        true,
      );
      await expect(
        image.has("/repo/reference/admin/src"),
        "The Admin's source is in the runtime image. It is a Developer's to edit and a browser bundle is what runs (ADR-0033); only `dist/` and the manifest that resolves it should ship.",
      ).resolves.toBe(false);
      await expect(image.has("/repo/reference/admin/vite.config.ts")).resolves.toBe(
        false,
      );
    },
    IMAGE_TIMEOUT,
  );

  it(
    "boots, applies every migration set, and serves",
    async () => {
      await using served = await startContainer({
        image: image.tag,
        name: `kobai-gate-runtime-${randomBytes(6).toString("hex")}`,
        env: { DATABASE_URL: databaseUrlForContainer(database.url), PORT: "3000" },
      });

      const health = await fetch(`${served.origin}/health`);
      expect(
        health.status,
        `The container answered /health with ${health.status}. Its output:\n${await served.logs()}`,
      ).toBe(200);
      const body = (await health.json()) as {
        migrations: { sets: { name: string; applied: number }[] };
      };
      expect(body).toMatchObject({ status: "ok" });

      // Not merely that the three sets are listed: that each of them applied something. A
      // set whose `migrations/` directory the prune removed reports zero and is otherwise
      // silent, which is the quietest way for a Plugin's tables to never exist.
      expect(
        body.migrations.sets.map((set) => [set.name, set.applied > 0]),
        `A migration set applied nothing inside the container. Its output:\n${await served.logs()}`,
      ).toEqual([
        ["core", true],
        ["plugin-price-log", true],
        ["project", true],
      ]);

      // The Admin, served by the Project's own process from the bytes `vite build` produced.
      const admin = await fetch(`${served.origin}/admin-ui/`);
      expect(admin.status).toBe(200);
      expect(admin.headers.get("content-type")).toContain("text/html");

      // ...and the store surface is still kobai's, at its own path, closed by default.
      const store = await fetch(`${served.origin}/store/variants/none/price`);
      expect(store.status).toBe(401);
    },
    IMAGE_TIMEOUT,
  );
});

type MigrationOwner = {
  readonly name: string;
  /** Absolute inside the image — the workspace is copied to `/repo` verbatim. */
  readonly pathInImage: string;
  /** One `.sql` per journal entry, which is what the runner will look for. */
  readonly sqlFiles: readonly string[];
};

async function migrationOwners(): Promise<MigrationOwner[]> {
  const { stdout } = await run(
    "pnpm",
    ["list", "--recursive", "--depth", "-1", "--json"],
    { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 },
  );

  const owners: MigrationOwner[] = [];
  for (const { name, path } of JSON.parse(stdout) as { name: string; path: string }[]) {
    const directory = join(path, "migrations");
    // The journal is what the runner reads first, so a package that has one owns a set and
    // a package that has none owns nothing — which is the same question `stat` would answer
    // and one fewer call to make.
    const journal = await readFile(join(directory, "meta/_journal.json"), "utf8").catch(
      () => null,
    );
    if (journal === null) continue;

    const { entries = [] } = JSON.parse(journal) as { entries?: { tag?: string }[] };
    owners.push({
      name,
      pathInImage: `/repo/${relative(repoRoot, directory)}`,
      sqlFiles: entries.flatMap(({ tag }) => (tag === undefined ? [] : [`${tag}.sql`])),
    });
  }

  if (owners.length === 0) {
    // Failing open would make the assertion above pass by checking nothing.
    throw new Error(
      "No workspace package was found to own a migration set, so the image was checked for none. Core always owns one.",
    );
  }
  return owners;
}
