import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parseArguments } from "./cli.ts";
import { scaffold } from "./scaffold.ts";

/**
 * What `create-kobai` does with a directory, short of installing anything.
 *
 * That a generated Project *runs* is proved end to end by
 * `tests/a-generated-project-boots.test.ts`, which is slow because it installs from a real
 * registry and boots the result. These are the cheap assertions that would otherwise hide
 * inside it — the refusals, the naming, the first commit — kept where they can fail fast and
 * say which one broke.
 */

const run = promisify(execFile);
const templateRoot = fileURLToPath(new URL("../template/", import.meta.url));
const workspaces: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kobai-scaffold-"));
  workspaces.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(workspaces.map((path) => rm(path, { recursive: true, force: true })));
});

describe("scaffolding a Project", () => {
  it("names the Project after its directory, and renames the Admin with it", async () => {
    const directory = join(await temporaryDirectory(), "corner-shop");
    const result = await scaffold({ directory, templateRoot, git: false });

    expect(result.name).toBe("corner-shop");

    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { name: string; dependencies: Record<string, string> };
    expect(manifest.name).toBe("corner-shop");

    // The Admin is a workspace package of the Project and is renamed with it — one token
    // does both, because `kobai-project-admin` carries `kobai-project` as a prefix.
    expect(manifest.dependencies["corner-shop-admin"]).toBe("workspace:*");

    const admin = JSON.parse(
      await readFile(join(directory, "admin/package.json"), "utf8"),
    ) as { name: string };
    expect(admin.name).toBe("corner-shop-admin");
  });

  it("renames the specifiers that resolve those packages at runtime", async () => {
    // The rename is not only cosmetic: two modules find their own files by asking Node to
    // resolve a package *by name*. A rename that reached the manifests and missed these
    // would produce a Project that installs, builds, and then cannot find its own Admin.
    const directory = join(await temporaryDirectory(), "corner-shop");
    await scaffold({ directory, templateRoot, git: false });

    await expect(
      readFile(join(directory, "src/admin-assets.ts"), "utf8"),
    ).resolves.toContain('import.meta.resolve("corner-shop-admin/package.json")');
    await expect(
      readFile(join(directory, "src/migration-set.ts"), "utf8"),
    ).resolves.toContain('import.meta.resolve("corner-shop/package.json")');
  });

  it("takes an explicit name over the directory's", async () => {
    const directory = join(await temporaryDirectory(), "some-folder");
    const result = await scaffold({
      directory,
      name: "my-store",
      templateRoot,
      git: false,
    });

    expect(result.name).toBe("my-store");
  });

  it("refuses a directory name that is not a usable package name", async () => {
    const directory = join(await temporaryDirectory(), "My Store");

    // Sanitising silently would leave a Developer with a Project named something they never
    // chose and never saw chosen.
    await expect(scaffold({ directory, templateRoot, git: false })).rejects.toThrow(
      /not a usable npm package name/,
    );
  });

  it("refuses to generate into a directory that is not empty", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "notes.md"), "mine\n");

    // Named explicitly because a temp directory's name is not a usable package name, and
    // that refusal would fire first and hide the one this test is about.
    await expect(
      scaffold({ directory, name: "corner-shop", templateRoot, git: false }),
    ).rejects.toThrow(/is not empty/);

    // ...and wrote nothing while refusing.
    await expect(readFile(join(directory, "notes.md"), "utf8")).resolves.toBe("mine\n");
  });

  it("hands back a git repository with one commit holding every file", async () => {
    const directory = join(await temporaryDirectory(), "corner-shop");
    const result = await scaffold({ directory, templateRoot });

    expect(result.committed).toBe(true);

    // The repository *is* the deliverable (ADR-0001): from here on, every diff is the
    // Developer's own rather than something that arrived with the scaffold.
    const { stdout } = await run("git", ["log", "--oneline"], { cwd: directory });
    expect(stdout.trim().split("\n")).toHaveLength(1);

    const tracked = await run("git", ["ls-files"], { cwd: directory });
    expect(tracked.stdout.trim().split("\n")).toHaveLength(result.files.length);

    // Nothing left unstaged: a Project that arrives already dirty makes the first `git
    // status` a puzzle.
    const status = await run("git", ["status", "--porcelain"], { cwd: directory });
    expect(status.stdout).toBe("");
  });

  it("generates a Project with no push script, and no devbox to hide one in", async () => {
    const directory = join(await temporaryDirectory(), "corner-shop");
    await scaffold({ directory, templateRoot, git: false });

    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    // The ban is the control (ADR-0030): `drizzle-kit push` diffs against the LIVE database,
    // so pushing this Project's schema would report success while silently dropping Core's
    // tables and every Plugin's. Nothing in the manifest explains itself — that is prose and
    // it lives in the ADR, because an editor reports every `"// …"` key in a manifest.
    expect(Object.keys(manifest.scripts).filter((name) => /push/i.test(name))).toEqual(
      [],
    );
    expect(
      Object.values(manifest.scripts).filter((run) =>
        /drizzle-kit[^\n;&|]*push/.test(run),
      ),
    ).toEqual([]);

    // And there is one file to check rather than two, which is the change: a generated
    // Project used to ship a `devbox.json` with a script list of its own. It ships no devbox
    // at all now (ADR-0083), so the manifest is the only place a command can live.
    await expect(readFile(join(directory, "devbox.json"), "utf8")).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe("the command line", () => {
  it("takes a directory, and defaults everything else", () => {
    expect(parseArguments(["my-store"])).toEqual({
      kind: "scaffold",
      directory: "my-store",
      git: true,
    });
  });

  it("takes a name and a --no-git", () => {
    expect(parseArguments(["my-store", "--name", "shop", "--no-git"])).toEqual({
      kind: "scaffold",
      directory: "my-store",
      name: "shop",
      git: false,
    });
  });

  it("refuses two directories rather than silently scaffolding one", () => {
    expect(parseArguments(["one", "two"])).toMatchObject({ kind: "error" });
  });

  it("refuses an unknown option rather than ignoring it", () => {
    // Ignoring one means a Developer who typed `--git=false` gets a git repository and no
    // hint that the flag did nothing.
    expect(parseArguments(["my-store", "--force"])).toMatchObject({ kind: "error" });
  });

  it("asks for a directory when given none", () => {
    expect(parseArguments([])).toMatchObject({ kind: "error" });
  });

  it("explains itself", () => {
    expect(parseArguments(["--help"])).toEqual({ kind: "help" });
  });
});
