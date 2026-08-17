import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR-0030, kept true by the build rather than by memory.
 *
 * `drizzle-kit push` diffs a schema against the LIVE database. Pushing Core's schema at a
 * database holding Plugin tables reports success and silently drops them, leaving their
 * migration tracking rows intact so the runner believes the work is done and cannot repair
 * it. Observed on branch `prototype/drizzle-multi-migration`, FINDINGS.md section E.
 *
 * The primary control is that the command is never available. A reviewer will not catch a
 * one-line `"db:push"` added in a hurry; this will.
 */
const repoRoot = new URL("../", import.meta.url);

/**
 * Every file that can define a runnable command. `devbox.json` is on this list because
 * ADR-0031 makes it where kobai's commands live — which makes it the file where someone
 * would reach for the convenient one.
 */
type CommandFile = {
  path: string;
  /** Command name → what it runs. */
  commands: Record<string, string>;
  /** Whether this file is expected to explain the absence, or merely to not offend. */
  explains: boolean;
};

async function commandFiles(): Promise<CommandFile[]> {
  const manifests = ["reference/package.json"];
  for (const entry of await readdir(new URL("packages/", repoRoot), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) manifests.push(`packages/${entry.name}/package.json`);
  }

  const files: CommandFile[] = await Promise.all(
    manifests.map(async (path) => ({
      path,
      commands: await read<{ scripts?: Record<string, string> }>(path).then(
        (json) => json.scripts ?? {},
      ),
      explains: true,
    })),
  );

  const devbox = await read<{ shell?: { scripts?: Record<string, string> } }>(
    "devbox.json",
  );
  files.push({
    path: "devbox.json",
    commands: devbox.shell?.scripts ?? {},
    explains: true,
  });

  // The workspace root owns no tables and runs no commands, but it must still not sprout
  // one.
  const root = await read<{ scripts?: Record<string, string> }>("package.json");
  files.push({ path: "package.json", commands: root.scripts ?? {}, explains: false });

  return files;
}

async function read<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(fileURLToPath(new URL(path, repoRoot)), "utf8")) as T;
}

/** A `// …` key is the comment explaining the absence, not a command. */
const isComment = (name: string) => name.startsWith("//");

describe("no push command exists anywhere", () => {
  it("finds none in any package manifest or in devbox.json", async () => {
    const offenders: string[] = [];

    for (const { path, commands } of await commandFiles()) {
      for (const [name, command] of Object.entries(commands)) {
        if (isComment(name)) continue;
        if (/push/i.test(name) || /drizzle-kit\s+push/.test(command)) {
          offenders.push(`${path} → ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("explains the absence where the command would have gone", async () => {
    // An empty space reads as an oversight. A comment reads as a decision.
    for (const { path, commands, explains } of await commandFiles()) {
      if (!explains) continue;
      const comments = Object.entries(commands)
        .filter(([name]) => isComment(name))
        .map(([, text]) => text)
        .join(" ");

      expect(comments, `${path} does not say why it has no push script`).toMatch(/push/i);
      expect(comments, `${path} does not point at the evidence`).toMatch(/0030/);
    }
  });
});
