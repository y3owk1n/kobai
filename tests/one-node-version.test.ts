import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readDevbox } from "./support/devbox-config.ts";

/**
 * One Node major, written in five places, held to being one number.
 *
 * `devbox.json` used to be the authority — `.github/dependabot.yml` said to lift its
 * `@types/node` major-ignore "the day the devbox Node pin moves". Under ADR-0083 most
 * readers of this repository will never open that file, so `.node-version` is the pin a
 * version manager and `actions/setup-node` both read, and the rest agree with it.
 *
 * They cannot be reduced to one copy: a Dockerfile names an image tag, `engines` names a
 * range, devbox names a nix package, and `.node-version` names a bare number. So they are
 * kept honest the way this repository keeps every other number written more than once —
 * by failing the build when they disagree.
 */

const repoRoot = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return readFile(fileURLToPath(new URL(path, repoRoot)), "utf8");
}

/** The first run of digits, which is the major in every notation used here. */
function major(source: string, where: string): number {
  const [found] = /\d+/.exec(source) ?? [];
  if (found === undefined) {
    throw new Error(`${where} carries no version at all, so nothing was compared to it.`);
  }
  return Number(found);
}

describe("the Node version is one number", () => {
  it("agrees across .node-version, engines, devbox and both Dockerfiles", async () => {
    const manifest = JSON.parse(await readText("package.json")) as {
      engines?: { node?: string };
    };
    const devboxPackages =
      ((await readDevbox()) as { packages?: string[] }).packages ?? [];
    const nodePackage = devboxPackages.find((name) => name.startsWith("nodejs@"));

    expect(nodePackage, "devbox.json pins no `nodejs@…` package.").toBeDefined();

    const pins = {
      ".node-version": major(await readText(".node-version"), ".node-version"),
      "package.json engines.node": major(
        manifest.engines?.node ?? "",
        "package.json engines.node",
      ),
      "devbox.json packages": major(nodePackage ?? "", "devbox.json packages"),
      Dockerfile: major(
        /^FROM node:(\S+)/m.exec(await readText("Dockerfile"))?.[1] ?? "",
        "Dockerfile",
      ),
      "reference/Dockerfile": major(
        /^FROM node:(\S+)/m.exec(await readText("reference/Dockerfile"))?.[1] ?? "",
        "reference/Dockerfile",
      ),
    };

    const distinct = new Set(Object.values(pins));

    expect(
      distinct.size,
      `These are one Node major and they have come apart: ${JSON.stringify(pins)}. Typing against a newer Node than the one that runs checks code against functions that do not exist at runtime, which is worse than being behind. Move all five, and lift the \`@types/node\` ignore in .github/dependabot.yml in the same change.`,
    ).toBe(1);
  });

  it("is the major dependabot holds @types/node to", async () => {
    // The ignore in that file exists because of this pin, and says so. If the two ever
    // disagree, the types are being held to a Node nothing here runs.
    const dependabot = await readText(".github/dependabot.yml");

    expect(dependabot).toContain(".node-version");
  });
});
