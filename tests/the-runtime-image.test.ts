import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@kobai/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BuiltImage,
  buildImage,
  fromContainer,
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

/**
 * The four the ticket named, measured in the 933 MB image.
 *
 * Every other forbidden name is read out of the Admin's manifest rather than copied here,
 * because ADR-0033 declares that package's entire toolchain a devDependency for exactly this
 * reason — so a component added with `shadcn add`, which drags in its own dependencies, is
 * covered without an edit to this file.
 */
const NAMED_IN_THE_TICKET = ["drizzle-kit", "vitest", "@biomejs/biome", "typescript"];

let image: BuiltImage;
let database: TestDatabase;
/** Every directory name under `node_modules/.pnpm` — one per installed package version. */
let installed: string[];

beforeAll(async () => {
  // Unique per run so two checkouts building the gate at once cannot overwrite each other's
  // image out from under the assertions below.
  image = await buildImage({
    tag: `kobai-gate-runtime:${randomBytes(6).toString("hex")}`,
    context: repoRoot,
    dockerfile: join(repoRoot, "Dockerfile"),
  });
  installed = (await image.read("ls node_modules/.pnpm")).split("\n").filter(Boolean);
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
      const forbidden = [...NAMED_IN_THE_TICKET, ...(await adminBuildTooling())];

      const shipped = forbidden.filter((name) =>
        installed.some((entry) => entry.startsWith(`${name.replace("/", "+")}@`)),
      );

      expect(
        shipped,
        "These are build tools, and they are in the runtime image. `pnpm install --prod` in the runtime stage does not remove them — it relinks over `node_modules/.pnpm` and leaves every byte where it was. The prune has to happen in the build stage, before anything is copied out of it. See the Dockerfile and #12.",
      ).toEqual([]);
    },
    IMAGE_TIMEOUT,
  );

  it(
    "keeps the runtime tree within its budget",
    async () => {
      const kilobytes = Number.parseInt(
        (await image.read("du -sk /repo")).trim().split(/\s+/)[0] ?? "",
        10,
      );

      expect(Number.isFinite(kilobytes)).toBe(true);
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
        const listed = await image
          .read(`ls ${owner.pathInImage}/*.sql 2>/dev/null || true`)
          .then((stdout) => stdout.split("\n").filter(Boolean));

        for (const file of owner.sqlFiles) {
          if (!listed.some((path) => path.endsWith(`/${file}`))) {
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
      const present = async (path: string) =>
        (await image.read(`test -e ${path} && echo yes || echo no`)).trim() === "yes";

      await expect(present("/repo/reference/admin/dist/index.html")).resolves.toBe(true);
      await expect(
        present("/repo/reference/admin/src"),
        "The Admin's source is in the runtime image. It is a Developer's to edit and a browser bundle is what runs (ADR-0033); only `dist/` and the manifest that resolves it should ship.",
      ).resolves.toBe(false);
      await expect(present("/repo/reference/admin/vite.config.ts")).resolves.toBe(false);
    },
    IMAGE_TIMEOUT,
  );

  it(
    "boots, applies every migration set, and serves",
    async () => {
      await using served = await startContainer({
        image: image.tag,
        name: `kobai-gate-runtime-${randomBytes(6).toString("hex")}`,
        env: { DATABASE_URL: fromContainer(database.url), PORT: "3000" },
      });

      const health = await fetch(`${served.origin}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        status: "ok",
        migrations: {
          sets: [{ name: "core" }, { name: "plugin-price-log" }, { name: "project" }],
        },
      });

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

/** Everything the Admin declares as a devDependency, minus the workspace links. */
async function adminBuildTooling(): Promise<string[]> {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, "reference/admin/package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };

  const declared = Object.keys(manifest.devDependencies ?? {});
  if (declared.length === 0) {
    // Failing open would make the assertion above pass over an empty list forever.
    throw new Error(
      "The Admin declares no devDependencies, so the runtime image was checked for almost nothing. ADR-0033 says its whole toolchain belongs there.",
    );
  }

  // `@kobai/*` are workspace packages: pnpm links them rather than storing them under
  // `.pnpm`, so asking whether they are installed there answers nothing either way.
  return declared.filter((name) => !name.startsWith("@kobai/"));
}

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
    const journal = await readFile(join(directory, "meta/_journal.json"), "utf8").catch(
      () => null,
    );
    if (journal === null) continue;
    if (
      !(await stat(directory).then(
        (entry) => entry.isDirectory(),
        () => false,
      ))
    ) {
      continue;
    }

    const { entries = [] } = JSON.parse(journal) as { entries?: { tag?: string }[] };
    owners.push({
      name,
      pathInImage: `/repo/${relative(repoRoot, directory)}`,
      sqlFiles: entries.flatMap(({ tag }) => (tag === undefined ? [] : [`${tag}.sql`])),
    });
  }

  if (owners.length === 0) {
    throw new Error(
      "No workspace package was found to own a migration set, so the image was checked for none. Core always owns one.",
    );
  }
  return owners;
}
