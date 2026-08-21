import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * Every setting kobai gives pnpm has to live where the **pinned** pnpm will read it.
 *
 * There are two ways it can fail to, and this repository has met both.
 *
 * **The setting sits in a file the reading pnpm does not know about.** `pnpm-workspace.yaml`
 * carries `overrides` — #69's two security pins, held against advisories that produce no
 * Dependabot PR because their parents never move — and `allowBuilds`, the allowlist naming
 * the only dependency permitted to run an install script. **pnpm 9 reads neither of them
 * from that file.** An install on it is not an error; it is a success that quietly resolves
 * `undici@5.29.0` and `esbuild@0.18.20` back in, enables every install script in the tree,
 * and writes a lockfile whose +404/-196 diff reads as format churn — `libc:` fields
 * dropped, peer suffixes dropped — so a reviewer seeing it beside a feature change has no
 * reason to look for two reinstated advisories inside it (#340).
 *
 * **The setting sits where the reading pnpm has stopped looking.** These settings used to
 * live under a `pnpm` key in the root `package.json`. pnpm 11 stopped reading that key: it
 * warns and ignores rather than failing, so anything left behind there is dead config that
 * looks live.
 *
 * **What is checked here is the pin, not the binary, and the difference is the point.**
 * #340's trigger is a contributor whose `pnpm` is older than `packageManager` says — pnpm
 * ≤9.6 predates `manage-package-manager-versions` and so ignores the pin rather than
 * self-correcting. **Nothing static can stop that**: by the time a test runs, the install
 * has already happened. A `preinstall` refusal is the only thing that could, and it was
 * rejected because an npm lifecycle hook runs *during* the install it is trying to govern
 * — ADR-0083 declines even an `install` script for that reason. So this file holds the two
 * things a repository can hold, and does not pretend to hold the third: that the pin never
 * drops below what this repository's own settings need, and that no setting moves somewhere
 * the pinned pnpm would not read it. The half aimed at a human is written down in
 * `pnpm-workspace.yaml` and in AGENTS.md instead.
 *
 * The install paths that *are* covered are covered already, by two different mechanisms
 * rather than one. CI and the workspace `Dockerfile` pass `--frozen-lockfile`, which fails
 * loudly on ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. `reference/Dockerfile` and the generated
 * Project's copy install **unfrozen on purpose** — a Project that has never been installed
 * has no lockfile, and the stricter flag would fail rather than write one — so their
 * immunity comes from `corepack enable` on the image's Node activating the pinned
 * `packageManager`, not from a flag they deliberately do not pass.
 *
 * Static: no network, no install, no container. Reached through `pnpm run ci` rather than
 * added as a step beside it (ADR-0083).
 */
const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Each setting this repository's `pnpm-workspace.yaml` files declare, against the oldest
 * pnpm that reads it **from that file**. The floor is the highest of them, so it is derived
 * rather than chosen — and a setting nobody has recorded a version for fails the build
 * instead of sliding underneath it.
 *
 * - **`packages`** — the key `pnpm-workspace.yaml` was created for, and older than any pnpm
 *   this repository could plausibly pin. `0.0.0` records that it can never set the floor;
 *   it is not a version anyone shipped.
 * - **`allowBuilds`** — *"Added in: v10.26.0"*, verbatim from pnpm's own settings reference
 *   (https://pnpm.io/settings/build). It *replaced* `onlyBuiltDependencies`, which pnpm 11
 *   removed outright, so a pnpm below 10.26 does not misread this key — it has never heard
 *   of it, and installs with no allowlist at all.
 * - **`overrides`** — pnpm's docs put **no "Added in" on this one**, which is why the number
 *   is 11.0.0 rather than something lower. pnpm 10.6 made `pnpm-workspace.yaml` able to hold
 *   "all the settings that `.npmrc` accepts", but `overrides` was never an `.npmrc` setting
 *   — it lived under `package.json`'s `pnpm` key — and pnpm 11.0 is the release that made
 *   this file the only place it is read from at all. So 11.0.0 is the oldest reading that
 *   can be *checked* rather than assumed, and it was checked: pnpm 11.22.0 honours this file
 *   (an install leaves `pnpm-lock.yaml` byte-identical) and pnpm 9.3.0 does not. A floor set
 *   too high forbids a pin nobody wants; a floor set too low lets #340 back in, so the
 *   undated case takes the conservative number and says here that it is one.
 */
const OLDEST_PNPM_THAT_READS: Record<string, string> = {
  packages: "0.0.0",
  allowBuilds: "10.26.0",
  overrides: "11.0.0",
};

/** `11.22.0` → `[11, 22, 0]`. Three numbers, because that is all a pin here ever is. */
function parts(version: string): number[] {
  return version.split(".").map(Number);
}

/** Negative, zero or positive, the way a comparator is. */
function compare(left: string, right: string): number {
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** A setting declared somewhere above with no version recorded for it here. */
function unrecorded(settings: readonly string[]): string[] {
  return settings.filter((name) => !(name in OLDEST_PNPM_THAT_READS));
}

/** A workspace file and the top-level settings it declares. */
type Declared = { path: string; settings: readonly string[] };

/** The floor, and the file and setting that set it. */
type Floor = { version: string; setting: string; path: string };

/**
 * The oldest pnpm that can read every setting across every workspace file — **one floor for
 * the repository, not one per file.**
 *
 * That is a deliberate simplification and it is worth saying which way it errs. The
 * generated Project's `pnpm-workspace.yaml` declares no `overrides`, so on its own it would
 * clear a lower bar; holding it to this one is conservative rather than wrong, and it cannot
 * bite in practice because `packages/create-kobai/src/adaptations.ts` copies the root's
 * `packageManager` into it, so the two pins cannot diverge without a deliberate edit — which
 * is a change worth having this conversation about.
 */
function floorFor(declared: readonly Declared[]): Floor {
  let highest: Floor = {
    version: "0.0.0",
    setting: "nothing declared needs a pnpm at all",
    path: "no workspace file",
  };

  for (const { path, settings } of declared) {
    for (const setting of settings) {
      const version = OLDEST_PNPM_THAT_READS[setting];
      if (version !== undefined && compare(version, highest.version) > 0) {
        highest = { version, setting, path };
      }
    }
  }

  return highest;
}

/** A manifest and the pnpm it pins. */
type Pin = { path: string; version: string };

/**
 * The pnpm a manifest pins through `packageManager`, if it pins one.
 *
 * Corepack allows a hash suffix — `pnpm@11.22.0+sha512-…` — which is not part of the
 * version. A `packageManager` naming some other package manager is not this check's
 * business; one naming pnpm in a shape this cannot compare is, and throws rather than
 * being skipped, because a silently unread pin is the failure this whole file is about.
 * That includes a prerelease: `pnpm@11.0.0-rc.1` is *below* the 11.0.0 it names, and
 * reading it as 11.0.0 would clear a floor it does not actually meet.
 */
function pnpmPin(path: string, manifest: unknown): Pin | undefined {
  const declared = (manifest as { packageManager?: unknown }).packageManager;
  if (typeof declared !== "string" || !declared.startsWith("pnpm@")) return undefined;

  const [, version] = /^pnpm@(\d+\.\d+\.\d+)(?:\+\S*)?$/.exec(declared) ?? [];
  if (version === undefined) {
    throw new Error(
      `${path} pins "${declared}", which is not a version this check can compare against the floor — and a prerelease is the case it will not guess at, since \`11.0.0-rc.1\` sorts below the 11.0.0 it names. Write it as pnpm@<major>.<minor>.<patch>, optionally with corepack's +<hash>.`,
    );
  }

  return { path, version };
}

/**
 * A `package.json` carrying a `pnpm` key, whatever is under it.
 *
 * Forbidden by construction rather than by name. pnpm 11 reads nothing from that key, so
 * anything there is dead config regardless of which setting it is — and a list of the
 * settings forbidden there would be the list that goes stale, which is the mistake
 * `tests/devbox-declares-no-commands.test.ts` exists to have stopped making.
 */
function pnpmKeyIn(path: string, manifest: unknown): string | undefined {
  const key = (manifest as { pnpm?: unknown }).pnpm;
  return key === undefined ? undefined : `${path} → pnpm: ${JSON.stringify(key)}`;
}

/**
 * Every tracked file matching a pathspec.
 *
 * Asked of git rather than walked, so `node_modules` and a second checkout under
 * `.claude/worktrees/` are out of reach by construction. Failing open would be worse than
 * failing: an empty list makes every assertion below pass by scanning nothing.
 */
async function tracked(pattern: string): Promise<string[]> {
  const { stdout } = await run("git", ["ls-files", "--", `:(glob)${pattern}`], {
    cwd: repoRoot,
  });
  const paths = stdout.trim().split("\n").filter(Boolean).sort();

  if (paths.length === 0) {
    throw new Error(`git tracks no ${pattern}, so nothing was checked.`);
  }

  return paths;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(repoRoot, path), "utf8")) as unknown;
}

/** Every workspace file, against the top-level settings it declares. */
async function declaredSettings(): Promise<Declared[]> {
  return Promise.all(
    (await tracked("**/pnpm-workspace.yaml")).map(async (path) => {
      const parsed = parseYaml(await readFile(join(repoRoot, path), "utf8")) ?? {};
      return { path, settings: Object.keys(parsed as Record<string, unknown>) };
    }),
  );
}

/** Every tracked `package.json`, parsed. Two checks below ask different things of the same read. */
async function manifests(): Promise<{ path: string; json: unknown }[]> {
  return Promise.all(
    (await tracked("**/package.json")).map(async (path) => ({
      path,
      json: await readJson(path),
    })),
  );
}

/** Every pnpm pinned anywhere in the repository. */
async function pins(): Promise<Pin[]> {
  return (await manifests()).flatMap(({ path, json }) => pnpmPin(path, json) ?? []);
}

describe("every setting reaches the pnpm that runs", () => {
  it("records the oldest pnpm that reads each setting the workspace files declare", async () => {
    const missing = (await declaredSettings()).flatMap(({ path, settings }) =>
      unrecorded(settings).map((name) => `${path} → ${name}`),
    );

    expect(
      missing,
      "A setting nobody has recorded a version for cannot raise the floor, so it would arrive silently — which is exactly how #340 happened. Add it to OLDEST_PNPM_THAT_READS with where the number came from.",
    ).toEqual([]);
  });

  it("pins a pnpm new enough to read every one of them", async () => {
    const floor = floorFor(await declaredSettings());
    const tooOld = (await pins()).filter(
      ({ version }) => compare(version, floor.version) < 0,
    );

    expect(
      tooOld,
      `${floor.path} declares \`${floor.setting}\`, which no pnpm below ${floor.version} reads from that file. A pin below it does not fail — it installs, having silently dropped #69's overrides and the install-script allowlist, and rewrites the lockfile with a diff that reads as format churn (#340). Raise the pin, or move the setting somewhere the pinned pnpm reads.`,
    ).toEqual([]);
  });

  it("finds no `pnpm` key in any package.json", async () => {
    const declaring = (await manifests()).flatMap(
      ({ path, json }) => pnpmKeyIn(path, json) ?? [],
    );

    expect(
      declaring,
      "pnpm 11 reads nothing from a `pnpm` key — it warns and ignores — so whatever is here is dead config that looks live. Settings belong in pnpm-workspace.yaml.",
    ).toEqual([]);
  });

  it("scans the workspace root and the Project every Developer receives", async () => {
    // Everything above is discovered rather than listed, which is what makes it cover the
    // next package without an edit. These five paths are not a second list competing with
    // that: they are the fail-open guard, because the way discovery breaks is by quietly
    // reaching less than it did, and a scan of nothing passes exactly like a scan of
    // everything. The generated Project is named because its workspace file and its pinned
    // pnpm are the ones that travel to a Developer.
    const files = (await declaredSettings()).map(({ path }) => path);
    const pinned = (await pins()).map(({ path }) => path);

    expect(files).toContain("pnpm-workspace.yaml");
    expect(files).toContain("packages/create-kobai/template/pnpm-workspace.yaml");
    expect(files).toContain("packages/create-kobai/standalone/pnpm-workspace.yaml");
    expect(pinned).toContain("package.json");
    expect(pinned).toContain("packages/create-kobai/template/package.json");
  });
});

describe("the floor a workspace file sets", () => {
  const root: Declared = {
    path: "pnpm-workspace.yaml",
    settings: ["packages", "allowBuilds", "overrides"],
  };
  const project: Declared = {
    path: "packages/create-kobai/template/pnpm-workspace.yaml",
    settings: ["packages", "allowBuilds"],
  };

  it("is the highest any one setting in any one file demands", () => {
    expect(floorFor([project, root])).toEqual({
      version: "11.0.0",
      setting: "overrides",
      path: "pnpm-workspace.yaml",
    });
  });

  it("names the file and setting that set it, so the message says what would be lost", () => {
    expect(floorFor([project])).toEqual({
      version: "10.26.0",
      setting: "allowBuilds",
      path: "packages/create-kobai/template/pnpm-workspace.yaml",
    });
  });

  it("refuses the pnpm 9 that reads none of them", () => {
    // The pin this repository would have had if #331 had gone the other way. pnpm 9.3.0 is
    // not hypothetical: it sits in the corepack cache of the machine #340 was found on.
    expect(compare("9.3.0", floorFor([root]).version)).toBeLessThan(0);
  });

  it("compares a version by each of its three numbers, not as a string", () => {
    // `"9" > "11"` and `"10.6.0" > "10.26.0"` are both true of strings and false of
    // versions, and either would set the floor below the one that matters.
    expect(compare("9.3.0", "11.0.0")).toBeLessThan(0);
    expect(compare("10.6.0", "10.26.0")).toBeLessThan(0);
    expect(compare("11.22.0", "11.22.0")).toBe(0);
  });

  it("fails on a setting whose floor nobody has recorded", () => {
    // pnpm 11.0 added `packageConfigs`; a pnpm 12 will add others. Each arrives as a
    // decision about the floor rather than underneath it.
    expect(unrecorded(["packages", "packageConfigs"])).toEqual(["packageConfigs"]);
  });
});

describe("reading a manifest", () => {
  const at = "packages/create-kobai/template/package.json";

  it("reads the pin through corepack's hash suffix", () => {
    expect(pnpmPin(at, { packageManager: "pnpm@11.22.0+sha512-abc" })?.version).toBe(
      "11.22.0",
    );
  });

  it("passes over a manifest that pins nothing", () => {
    expect(pnpmPin(at, { name: "kobai-reference" })).toBeUndefined();
  });

  it("passes over a packageManager that is not pnpm's", () => {
    expect(pnpmPin(at, { packageManager: "yarn@4.9.1" })).toBeUndefined();
  });

  it("refuses a pnpm pin it cannot compare, rather than skipping it", () => {
    // A skipped pin is an unchecked pin, which is the shape of the bug this file is about.
    expect(() => pnpmPin(at, { packageManager: "pnpm@11" })).toThrow(/pnpm@11/);
    // And a prerelease is below the release it names, so reading it as that release would
    // clear a floor it does not meet.
    expect(() => pnpmPin(at, { packageManager: "pnpm@11.0.0-rc.1" })).toThrow(/rc\.1/);
  });

  it("sees a `pnpm` key whatever is under it", () => {
    expect(pnpmKeyIn(at, { pnpm: { overrides: { "a>b": "^1" } } })).toContain(
      "overrides",
    );
    expect(pnpmKeyIn(at, { pnpm: {} })).toContain(at);
    expect(pnpmKeyIn(at, { name: "kobai-reference" })).toBeUndefined();
  });
});
