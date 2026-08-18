import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@kobai/core/testing";
import { scaffold } from "create-kobai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type LocalRegistry,
  publishPackages,
  startLocalRegistry,
} from "./support/local-registry.ts";
import { bootProject, PROJECT_TIMEOUT, runInProject } from "./support/project.ts";

/**
 * The acceptance test for #11, and the only one that proves the promise rather than
 * describing it: **generate a Project into a clean directory, install it, boot it, serve a
 * request.**
 *
 * Every cheaper version of this test was considered and is worth less. Generating inside
 * this workspace would resolve `workspace:*` and prove nothing about a Developer's machine.
 * A `file:` dependency would boot and would not be an ordinary versioned dependency, which
 * is the one thing ADR-0001 actually claims. Asserting on the generated files without
 * running them would pass with a Project that cannot install.
 *
 * So the Project generated here says `"@kobai/core": "^0.1.0"` — a plain semver range, the
 * same one a Developer receives — and resolves it from a **real registry** holding the
 * packages this commit built (ADR-0034). The only thing the test supplies that a Developer
 * would not is an `.npmrc` pointing the `@kobai` scope at that registry instead of at
 * npmjs.com, which is the same line anyone using a private mirror writes.
 *
 * It is slow — an install, two builds and a boot — and that is the price of the claim.
 */

const run = promisify(execFile);

let registry: LocalRegistry;
let workspace: string;
let project: string;
let database: TestDatabase;

beforeAll(async () => {
  registry = await startLocalRegistry();
  await publishPackages(registry, [
    "packages/core",
    "packages/client",
    "packages/plugin-price-log",
    "packages/plugin-made-to-order",
  ]);

  workspace = await mkdtemp(join(tmpdir(), "kobai-generated-"));
  project = join(workspace, "my-store");
  database = await createTestDatabase();
}, PROJECT_TIMEOUT);

afterAll(async () => {
  await database?.drop();
  await registry?.close();
  await rm(workspace, { recursive: true, force: true });
});

describe("a Project generated into a clean directory", () => {
  it(
    "installs kobai as an ordinary versioned dependency, builds, boots and serves",
    async () => {
      const result = await scaffold({ directory: project });

      // Criterion 2: what a Developer gets is a repository, not a folder. The first commit
      // is what makes every later change visibly theirs.
      expect(result.committed).toBe(true);
      const log = await run("git", ["log", "--oneline"], { cwd: project });
      expect(log.stdout.trim().split("\n")).toHaveLength(1);

      // Criterion 3, read straight out of what was written: a semver range, not a path, not
      // a tarball, not `workspace:*`.
      const manifest = JSON.parse(
        await readFile(join(project, "package.json"), "utf8"),
      ) as { name: string; dependencies: Record<string, string> };
      expect(manifest.name).toBe("my-store");
      expect(manifest.dependencies["@kobai/core"]).toMatch(/^\^\d+\.\d+\.\d+$/);

      // The one line a Developer would not write: point the `@kobai` scope at the registry
      // holding this commit's packages. Everything else resolves from wherever npm normally
      // looks, because this registry proxies nothing.
      await writeFile(
        join(project, ".npmrc"),
        `@kobai:registry=${registry.url}\n//${registry.url.replace(/^https?:\/\//, "")}/:_authToken=kobai-local\n`,
      );

      await runInProject(project, "pnpm", ["install"]);
      // The same command the Project's own `devbox run build` and its Dockerfile run —
      // `--include-workspace-root` included, because the Project is the root of its own
      // workspace and `pnpm -r` alone would silently build only the Admin.
      await runInProject(project, "pnpm", ["-r", "--include-workspace-root", "build"]);

      const served = await bootProject(project, database.url);
      try {
        // Criterion 10: it serves a request. `/health` is the one that also says whether
        // every migration set applied — Core's, the Plugin's, and the Project's own.
        const health = await fetch(`${served.origin}/health`);
        expect(health.status).toBe(200);
        await expect(health.json()).resolves.toMatchObject({
          status: "ok",
          migrations: {
            sets: [
              { name: "core" },
              { name: "plugin-price-log" },
              { name: "plugin-made-to-order" },
              { name: "project" },
            ],
          },
        });

        // Criterion 7: the vendored Admin was generated as source and built by the Project's
        // own toolchain, and the Project's own process serves it.
        const admin = await fetch(`${served.origin}/admin-ui/`);
        expect(admin.status).toBe(200);
        expect(admin.headers.get("content-type")).toContain("text/html");

        // ...and the API is still kobai's, at its own paths, closed by default.
        const store = await fetch(`${served.origin}/store/variants/none/price`);
        expect(store.status).toBe(401);
      } finally {
        await served.stop();
      }
    },
    PROJECT_TIMEOUT,
  );
});
