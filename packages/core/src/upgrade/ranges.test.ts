import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rewriteKobaiRanges } from "./ranges.ts";

/**
 * The version bump, on a Project shaped like the one `create-kobai` generates: a root
 * manifest and a vendored Admin's, kobai in `dependencies` in one and `devDependencies` in
 * the other.
 */

let project: string | undefined;

afterEach(async () => {
  if (project) await rm(project, { recursive: true, force: true });
  project = undefined;
});

async function aProject(files: Record<string, unknown>): Promise<string> {
  project = await mkdtemp(join(tmpdir(), "kobai-upgrade-"));
  for (const [path, contents] of Object.entries(files)) {
    const at = join(project, path);
    await mkdir(join(at, ".."), { recursive: true });
    await writeFile(at, `${JSON.stringify(contents, null, 2)}\n`);
  }
  return project;
}

const readManifest = async (at: string, path: string) =>
  JSON.parse(await readFile(join(at, path), "utf8")) as Record<
    string,
    Record<string, string>
  >;

describe("bumping a Project's kobai dependencies", () => {
  it("moves every kobai range in every manifest the Project owns", async () => {
    const at = await aProject({
      "package.json": {
        name: "my-store",
        dependencies: { "@kobai/core": "^0.1.0", "@kobai/plugin-price-log": "^0.1.0" },
        devDependencies: { "drizzle-kit": "^0.31.5" },
      },
      "admin/package.json": {
        name: "my-store-admin",
        devDependencies: { "@kobai/client": "^0.1.0", vite: "^8.2.1" },
      },
    });

    const rewrite = await rewriteKobaiRanges({ directory: at, to: "1.0.0" });

    expect(rewrite.changed).toEqual([
      {
        file: "package.json",
        dependency: "@kobai/core",
        from: "^0.1.0",
        to: "^1.0.0",
      },
      {
        file: "package.json",
        dependency: "@kobai/plugin-price-log",
        from: "^0.1.0",
        to: "^1.0.0",
      },
      {
        file: "admin/package.json",
        dependency: "@kobai/client",
        from: "^0.1.0",
        to: "^1.0.0",
      },
    ]);

    const root = await readManifest(at, "package.json");
    expect(root.dependencies?.["@kobai/core"]).toBe("^1.0.0");
    // Everything that is not kobai's is left exactly as it was.
    expect(root.devDependencies?.["drizzle-kit"]).toBe("^0.31.5");
    expect((await readManifest(at, "admin/package.json")).devDependencies?.vite).toBe(
      "^8.2.1",
    );
  });

  it("keeps the operator the Developer chose", async () => {
    const at = await aProject({
      "package.json": {
        name: "my-store",
        dependencies: {
          "@kobai/core": "~0.1.0",
          "@kobai/client": "0.1.0",
          "@kobai/plugin-price-log": "^0.1.0",
        },
      },
    });

    await rewriteKobaiRanges({ directory: at, to: "1.0.0" });

    const root = await readManifest(at, "package.json");
    expect(root.dependencies).toEqual({
      "@kobai/core": "~1.0.0",
      "@kobai/client": "1.0.0",
      "@kobai/plugin-price-log": "^1.0.0",
    });
  });

  it("leaves a range it does not understand alone, and says which and why", async () => {
    // An upgrade command that flattened `>=0.1.0 <0.3.0` into `^1.0.0` would be making a
    // decision that is the Developer's. Reporting it is the whole of what it may do.
    const at = await aProject({
      "package.json": {
        name: "my-store",
        dependencies: {
          "@kobai/core": ">=0.1.0 <0.3.0",
          "@kobai/plugin-price-log": "workspace:*",
        },
      },
    });

    const rewrite = await rewriteKobaiRanges({ directory: at, to: "1.0.0" });

    expect(rewrite.changed).toEqual([]);
    expect(rewrite.leftAlone.map((entry) => entry.dependency)).toEqual([
      "@kobai/core",
      "@kobai/plugin-price-log",
    ]);
    expect((await readManifest(at, "package.json")).dependencies).toEqual({
      "@kobai/core": ">=0.1.0 <0.3.0",
      "@kobai/plugin-price-log": "workspace:*",
    });
  });

  it("never looks inside node_modules, where an installed copy's manifests live", async () => {
    const at = await aProject({
      "package.json": { name: "my-store", dependencies: { "@kobai/core": "^0.1.0" } },
      "node_modules/@kobai/core/package.json": { name: "@kobai/core", version: "0.1.0" },
    });

    const rewrite = await rewriteKobaiRanges({ directory: at, to: "1.0.0" });

    expect(rewrite.changed.map((change) => change.file)).toEqual(["package.json"]);
  });

  it("keeps the explanatory keys a kobai Project carries", async () => {
    // A generated Project explains itself in `"// dependencies"` keys, and a command that
    // reserialised the manifest without them would delete the reasoning as a side effect.
    const at = await aProject({
      "package.json": {
        name: "my-store",
        "// dependencies": "why these are what they are",
        dependencies: { "@kobai/core": "^0.1.0" },
      },
    });

    await rewriteKobaiRanges({ directory: at, to: "1.0.0" });

    const root = await readManifest(at, "package.json");
    expect(root["// dependencies"]).toBe("why these are what they are");
    expect(Object.keys(root)).toEqual(["name", "// dependencies", "dependencies"]);
  });

  it("refuses a directory that is not a Project at all", async () => {
    const at = await aProject({ "readme.txt": {} });

    await expect(rewriteKobaiRanges({ directory: at, to: "1.0.0" })).rejects.toThrow(
      /not a kobai Project/,
    );
  });
});
