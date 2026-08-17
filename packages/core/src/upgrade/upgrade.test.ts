import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEMOD_SET_FORMAT, type Codemod } from "./codemods.ts";
import { formatUpgradeReport } from "./report.ts";
import { CodemodSetMissing } from "./set.ts";
import { type LoadedCodemodSet, upgradeProject } from "./upgrade.ts";

/**
 * The command as a whole, against a Project made of manifests.
 *
 * The install and the loading of the target version's codemod set are injected here, which
 * is the only way this runs in milliseconds — `tests/the-upgrade-gate.test.ts` does both for
 * real, across a real version bump, and boots what comes out. The two are not alternatives:
 * this file pins the behaviour a gate cannot reach without a breaking change to migrate, and
 * the gate pins that the shipped command is what runs.
 */

let project: string | undefined;

afterEach(async () => {
  if (project) await rm(project, { recursive: true, force: true });
  project = undefined;
});

/** A Project with kobai installed at `installed`, shaped like a generated one. */
async function aProject(installed: string): Promise<string> {
  project = await mkdtemp(join(tmpdir(), "kobai-upgrade-"));

  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "my-store",
        dependencies: { "@kobai/core": "^0.1.0", "@kobai/plugin-price-log": "^0.1.0" },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(project, "admin"), { recursive: true });
  await writeFile(
    join(project, "admin/package.json"),
    `${JSON.stringify(
      { name: "my-store-admin", devDependencies: { "@kobai/client": "^0.1.0" } },
      null,
      2,
    )}\n`,
  );

  // An installed Core at `node_modules/@kobai/core`, which is where the version being
  // upgraded *from* is read — off the filesystem rather than through the module resolver,
  // whose cache would answer with the package from before an install.
  const core = join(project, "node_modules/@kobai/core");
  await mkdir(core, { recursive: true });
  await writeFile(
    join(core, "package.json"),
    `${JSON.stringify({
      name: "@kobai/core",
      version: installed,
      exports: { "./package.json": "./package.json" },
    })}\n`,
  );

  return project;
}

const nothingInstalls = async () => undefined;

function shipping(
  ...codemods: Codemod[]
): (directory: string) => Promise<LoadedCodemodSet> {
  return async () => ({ codemods, source: "@kobai/core@1.0.0" });
}

function fake(id: string, introducedIn: string, changed: string[] = []): Codemod {
  return {
    id,
    title: `Does ${id}`,
    introducedIn,
    apply: async () => changed,
  };
}

describe("upgrading a Project across a version", () => {
  it("bumps every kobai range, installs, and reads the set the new version ships", async () => {
    const at = await aProject("0.1.0");
    let installedIn: string | undefined;

    const report = await upgradeProject({
      directory: at,
      to: "1.0.0",
      install: async (directory) => {
        installedIn = directory;
      },
      loadCodemodSet: shipping(),
    });

    expect(installedIn).toBe(at);
    expect(report.from).toBe("0.1.0");
    expect(report.crossesMajor).toBe(true);
    expect(report.ranges.changed).toHaveLength(3);
    expect(report.codemods).toMatchObject({ kind: "none-for-this-boundary", shipped: 0 });
  });

  it("runs the codemods the target version ships, in order, and says what they changed", async () => {
    const at = await aProject("0.1.0");

    const report = await upgradeProject({
      directory: at,
      to: "2.0.0",
      install: nothingInstalls,
      loadCodemodSet: shipping(
        fake("2.0.0-second", "2.0.0", ["kobai.config.ts"]),
        fake("1.0.0-first", "1.0.0", ["src/app.ts"]),
        fake("3.0.0-not-yet", "3.0.0"),
      ),
    });

    expect(report.codemods).toEqual({
      kind: "applied",
      source: "@kobai/core@1.0.0",
      applied: [
        { id: "1.0.0-first", title: "Does 1.0.0-first", changed: ["src/app.ts"] },
        { id: "2.0.0-second", title: "Does 2.0.0-second", changed: ["kobai.config.ts"] },
      ],
    });
  });

  it("names the codemod that failed and what had already run", async () => {
    const at = await aProject("0.1.0");
    const explodes: Codemod = {
      id: "1.0.1-explodes",
      title: "Fails",
      introducedIn: "1.0.1",
      apply: async () => {
        throw new Error("no");
      },
    };

    await expect(
      upgradeProject({
        directory: at,
        to: "2.0.0",
        install: nothingInstalls,
        loadCodemodSet: shipping(fake("1.0.0-ran", "1.0.0"), explodes),
      }),
    ).rejects.toThrow(/1\.0\.1-explodes.*1 codemod\(s\) ran before it.*1\.0\.0-ran/s);
  });

  it("reports a target version that ships no set at all, rather than reporting none", async () => {
    // The two are different answers and the difference matters: a version that intends to
    // ship no codemods exports an empty set.
    const at = await aProject("0.1.0");

    const report = await upgradeProject({
      directory: at,
      to: "1.0.0",
      install: nothingInstalls,
      loadCodemodSet: async () => {
        throw new CodemodSetMissing("@kobai/core@1.0.0 has no `./codemods` export");
      },
    });

    expect(report.codemods).toMatchObject({ kind: "no-set-shipped" });
  });

  it("fails outright on a set it cannot read, rather than reporting none", async () => {
    // The distinction ADR-0035 exists to make. A set that is *absent* is survivable and
    // reported; a set that is present and written to a contract this runner does not
    // understand must stop the command, because "no codemods" would be the same sentence a
    // successful empty boundary prints.
    const at = await aProject("0.1.0");

    await expect(
      upgradeProject({
        directory: at,
        to: "1.0.0",
        install: nothingInstalls,
        loadCodemodSet: async () => {
          throw new Error("declares codemod set format 99");
        },
      }),
    ).rejects.toThrow(/format 99/);
  });

  it("refuses to go backwards", async () => {
    const at = await aProject("1.0.0");

    await expect(
      upgradeProject({ directory: at, to: "0.1.0", install: nothingInstalls }),
    ).rejects.toThrow(/older/);
  });

  it("refuses a Project with no kobai installed, because there is nothing to upgrade from", async () => {
    project = await mkdtemp(join(tmpdir(), "kobai-upgrade-"));
    await writeFile(join(project, "package.json"), '{"name":"my-store"}\n');

    await expect(
      upgradeProject({ directory: project, to: "1.0.0", install: nothingInstalls }),
    ).rejects.toThrow(/no @kobai\/core installed/);
  });

  it("treats a 0.x minor as a major, because npm's caret does", async () => {
    // `^0.1.0` is `>=0.1.0 <0.2.0`, so 0.1.0 → 0.2.0 breaks a Project exactly as 1.x → 2.x
    // does. Calling kobai's whole pre-1.0 life one major would run no codemods through it.
    const at = await aProject("0.1.0");

    const report = await upgradeProject({
      directory: at,
      to: "0.2.0",
      install: nothingInstalls,
      loadCodemodSet: shipping(),
    });

    expect(report.crossesMajor).toBe(true);
  });
});

describe("what the command tells a Developer at an empty boundary", () => {
  it("says it found none, rather than saying nothing", async () => {
    const at = await aProject("0.1.0");

    const printed = formatUpgradeReport(
      await upgradeProject({
        directory: at,
        to: "1.0.0",
        install: nothingInstalls,
        loadCodemodSet: shipping(),
      }),
    );

    expect(printed).toContain("@kobai/core 0.1.0 → 1.0.0");
    expect(printed).toContain("@kobai/core");
    expect(printed).toContain("^0.1.0 → ^1.0.0");
    expect(printed).toContain("ships no codemods at all");
    expect(printed).toContain("not the same as nothing attempted");
    expect(printed).toContain("applied 0 codemods");
  });

  it("distinguishes a set that is empty from one that had nothing matching", async () => {
    const at = await aProject("0.1.0");

    const printed = formatUpgradeReport(
      await upgradeProject({
        directory: at,
        to: "1.0.0",
        install: nothingInstalls,
        // Ships one, for a boundary this Project is not crossing.
        loadCodemodSet: shipping(fake("9.0.0-later", "9.0.0")),
      }),
    );

    expect(printed).toContain("ships 1, none of which applies to 0.1.0 → 1.0.0");
    expect(printed).not.toContain("ships no codemods at all");
  });

  it("says loudly when the version arrived at ships no set at all", async () => {
    const at = await aProject("0.1.0");

    const printed = formatUpgradeReport(
      await upgradeProject({
        directory: at,
        to: "1.0.0",
        install: nothingInstalls,
        loadCodemodSet: async () => {
          throw new CodemodSetMissing("no `./codemods` export");
        },
      }),
    );

    expect(printed).toContain("ships no codemod set");
    expect(printed).toContain("not the same as having nothing");
  });

  it("names a range it refused to touch", async () => {
    const at = await aProject("0.1.0");
    await writeFile(
      join(at, "package.json"),
      `${JSON.stringify({ name: "my-store", dependencies: { "@kobai/core": ">=0.1.0 <0.3.0" } }, null, 2)}\n`,
    );

    const printed = formatUpgradeReport(
      await upgradeProject({
        directory: at,
        to: "1.0.0",
        install: nothingInstalls,
        loadCodemodSet: shipping(),
      }),
    );

    expect(printed).toContain("left at >=0.1.0 <0.3.0");
  });
});
