import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readDevbox } from "./support/devbox-config.ts";

/**
 * `devbox.json` declares no scripts, anywhere in this repository.
 *
 * kobai's commands used to live there — the whole list, with `package.json` carrying a note
 * saying it had none on purpose, "so there is one list rather than two that drift". The
 * reasoning was right and it was applied to the wrong file: the list ended up in the one
 * place a contributor arriving from any other TypeScript repository would not look, behind a
 * tool they had no reason to have (ADR-0083).
 *
 * So the rule inverts, and it is **asserted from the other side rather than noted**. That is
 * the whole reason this file exists: a note in `package.json` said what was true and could
 * not keep being true, while this fails the build the moment a second command list starts to
 * grow. Forbidding the class is also stronger than what it replaces — `tests/no-push-script
 * .test.ts` used to forbid one script here by name, and #30's `"//db:push"` hazard, where
 * devbox generated a key into a runnable command, cannot arise in a file with no keys.
 *
 * devbox is not being taken away. It pins Node and enables corepack, which is what one
 * maintainer wanted it for; it simply is not how anything is run.
 */

/**
 * Every `devbox.json` this repository has ever had.
 *
 * There is one now. The reference Project's and the copy of it every Developer received are
 * both gone (#307) — a Developer owns their Project outright, and a scaffolder that bakes a
 * tool into the artifact makes that tool a dependency of running your own store. They are
 * still named here rather than dropped from the list, so that one reappearing is checked
 * rather than unnoticed.
 */
const DEVBOX_FILES = [
  "devbox.json",
  "reference/devbox.json",
  "packages/create-kobai/template/devbox.json",
] as const;

/** The copies that actually exist. */
async function present(): Promise<string[]> {
  const found: string[] = [];
  for (const path of DEVBOX_FILES) {
    try {
      await readFile(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
      found.push(path);
    } catch {
      // Deleted, which is the direction of travel.
    }
  }
  return found;
}

describe("devbox is a Node provisioner and not a command runner", () => {
  it("declares no scripts in any devbox.json", async () => {
    const declaring: string[] = [];

    for (const path of await present()) {
      const scripts = (await readDevbox(path)).shell?.scripts ?? {};
      const names = Object.keys(scripts);
      if (names.length > 0) declaring.push(`${path}: ${names.join(", ")}`);
    }

    expect(
      declaring,
      "kobai's commands are `package.json`'s (ADR-0083). A script here is a second list, and the one nobody without devbox can run — put it in the manifest beside the others.",
    ).toEqual([]);
  });

  it("still pins Node, which is the whole of what it is for", async () => {
    const config = (await readDevbox()) as { packages?: string[] };

    expect(config.packages ?? []).toContain("nodejs@22");
  });

  it("finds the workspace's own copy, so this cannot pass by scanning nothing", async () => {
    expect(await present()).toContain("devbox.json");
  });
});
