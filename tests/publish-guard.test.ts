import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `private: true` used to be the only thing between a stray `pnpm publish` and npmjs.com,
 * and ADR-0034 removed it from four packages on purpose — a generated Project depends on
 * them as ordinary versioned dependencies, and `workspace:*` resolves nowhere outside this
 * workspace.
 *
 * So something else has to stand where it stood. `publishConfig.registry`, pinned at a
 * loopback address, is that something: npm resolves the publish target from it **before it
 * opens a connection**, and it beats `--registry` and `npm_config_registry` alike — measured
 * while building this, not assumed. A publish that reaches the public registry therefore has
 * to be a deliberate act by someone who worked around this line, rather than a command
 * someone typed in the wrong directory.
 *
 * This is ADR-0030's shape applied to a different danger: the primary control is that the
 * dangerous thing is not reachable by accident, and a test is what keeps the control in
 * place after the person who added it has gone.
 */

const repoRoot = new URL("../", import.meta.url);

/** Loopback, however it is spelled. Anything else is a registry on somebody else's machine. */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/;

type Manifest = {
  readonly path: string;
  readonly name?: string;
  readonly private?: boolean;
  readonly version?: string;
  readonly publishConfig?: { registry?: string };
};

async function packageManifests(): Promise<Manifest[]> {
  const entries = await readdir(new URL("packages/", repoRoot), { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());

  if (directories.length === 0) {
    // Failing open would make this whole file pass by checking nothing.
    throw new Error(
      "No packages were found, so no manifest was checked for a publish guard.",
    );
  }

  return Promise.all(
    directories.map(async (entry) => {
      const path = `packages/${entry.name}/package.json`;
      const json = JSON.parse(
        await readFile(fileURLToPath(new URL(path, repoRoot)), "utf8"),
      ) as Omit<Manifest, "path">;
      return { ...json, path };
    }),
  );
}

/** Every package this repository intends to publish — everything not marked private. */
const publishable = (manifests: Manifest[]) =>
  manifests.filter((manifest) => manifest.private !== true);

describe("publishing kobai has to be deliberate", () => {
  it("pins every publishable package's registry at a loopback address", async () => {
    const unguarded = publishable(await packageManifests())
      .filter((manifest) => !LOOPBACK.test(manifest.publishConfig?.registry ?? ""))
      .map(
        (manifest) =>
          `${manifest.path} → publishConfig.registry is ${JSON.stringify(manifest.publishConfig?.registry ?? null)}`,
      );

    expect(
      unguarded,
      "A publishable package with no loopback registry pin can be published to npmjs.com by a single mistyped command. See ADR-0034.",
    ).toEqual([]);
  });

  it("publishes something, so the guard is guarding a real thing", async () => {
    // The way this file stops meaning anything is every package going back to `private:
    // true` — at which point the assertion above passes over an empty list forever.
    const names = publishable(await packageManifests()).map((manifest) => manifest.name);

    expect(names).toContain("@kobai/core");
    expect(names).toContain("create-kobai");
  });

  it("gives every published package a real version rather than 0.0.0", async () => {
    // `0.0.0` is not a starting point, it is an absence — and a generated Project pins a
    // caret range against whatever is here, so a version nobody chose is a range nobody
    // chose. ADR-0034 records why it is 0.1.0.
    const unversioned = publishable(await packageManifests())
      .filter(
        (manifest) => manifest.version === undefined || manifest.version === "0.0.0",
      )
      .map((manifest) => `${manifest.path} → ${manifest.version}`);

    expect(unversioned).toEqual([]);
  });

  it("keeps every published package's version in step", async () => {
    // They are released together and a generated Project pins one range for all of them, so
    // two versions here would mean a Project asking for a combination nothing ever tested.
    const versions = new Set(publishable(await packageManifests()).map((m) => m.version));

    expect([...versions]).toHaveLength(1);
  });
});
