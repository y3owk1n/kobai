import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Which files the gate lints, kept true by the build rather than by whoever last read a glob.
 *
 * `biome.json`'s exclusion list used to carry `"!.devbox"`, which is **root-anchored**: it
 * excluded the workspace's own `.devbox` and nothing else. `reference/` ships a `devbox.json`
 * of its own, so `cd reference && devbox run build` — an ordinary thing to do, it is the
 * Project a maintainer boots — left a nix profile manifest that Biome then scanned, and the
 * gate went red on a generated file in a gitignored directory (#203). Nothing in the failure
 * named `reference/`, and `devbox run format` could not repair it: it rewrote the manifest,
 * which the next `devbox run` regenerated in its original form. `.scratch/` was the same bug
 * with no ticket — AGENTS.md hands that directory to agents as scratch space, and the gate
 * linted whatever was left there.
 *
 * The decision this file enforces is in
 * `docs/adr/0068-gitignore-is-the-one-statement-of-what-a-checkout-generates.md`:
 * **`.gitignore` decides what is not
 * source, and `biome.json` decides which of the files that *are* in the repository are
 * generated.** `vcs.useIgnoreFile` is what makes the first half true, at any depth, for every
 * artifact `.gitignore` already names — so the exclusions that survive in `includes` are
 * exactly the ones `.gitignore` can never carry, because git tracks them.
 *
 * The fixture below is the whole argument in one directory: the repository's real `biome.json`
 * and real `.gitignore`, over a tree holding one file of every kind. **Every file in it carries
 * a finding, and every entry can fail** — so what Biome reports *is* what Biome looked at,
 * where an assertion that only counted findings could pass by looking at nothing at all. The
 * `linted: true` entry is what rules that out, and the `dist` entry is what holds the
 * deletion honest: that glob came out of `includes` on the strength of `.gitignore` covering
 * it, and this is where that strength is checked rather than asserted.
 *
 * Two exclusions have no entry here for that same reason, and the note above `FIXTURE` says
 * which and why. An entry that would pass with the thing it checks deleted is decoration.
 */
const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const biomeBin = join(repoRoot, "node_modules/.bin/biome");

/**
 * One file in the fixture, and what the gate owes it.
 *
 * `source` always carries a finding — a `useTemplate` violation in TypeScript, a formatting
 * difference in JSON and YAML — so `linted` is answerable by reading Biome's report.
 */
type Fixture = {
  /** Path within the fixture tree, POSIX-separated. */
  readonly path: string;
  /** Contents, carrying a finding Biome reports at or above the gate's floor (ADR-0039). */
  readonly source: string;
  /** Whether the gate should see it. */
  readonly linted: boolean;
  /** Quoted verbatim when the assertion fails, because a bare path says nothing. */
  readonly why: string;
};

/** A `lint/style/useTemplate` finding — `biome.json` lifts that rule to the floor. */
const FINDING_IN_TYPESCRIPT =
  'export const greet = (n: string): string => "Hello, " + n;\n';

/** A formatting difference: Biome would close the gap after the comma. */
const FINDING_IN_JSON = '{ "generated": true,   "byHand": false }\n';

/**
 * Two exclusions deliberately have no entry below, because neither could fail if it did.
 *
 * **`node_modules` is Biome's own, unconditionally.** With the `vcs` block deleted *and* no
 * ignore file at all, a finding under `node_modules` is still not reported while `dist` and
 * `.scratch` both are — so the `node_modules` exclusion this change removed was already
 * inert, and a fixture entry for it would pass however `biome.json` were mangled.
 *
 * **Biome 2.5.8 processes no YAML**, so the `pnpm-lock.yaml` exclusion reports nothing today
 * either. It is kept, and depth-anchored, because the lockfile is a tracked generated
 * artifact and so belongs in `includes` under ADR-0068's rule — it is right on the day Biome
 * formats YAML rather than red on it. Both were measured rather than assumed; see ADR-0068.
 */

/**
 * Order matters here, and only for the `linted: true` entry, which has to come **last**.
 *
 * A file Biome refuses to *configure* — the nested `biome.json` an agent worktree brings —
 * stops the whole run, so nothing at all is reported and the control fails alongside it. Read
 * in that order the failure says "the gate is looking at nothing", which is true and names
 * nothing; read with the offending entry first it names the file that stopped it.
 */
const FIXTURE: readonly Fixture[] = [
  {
    path: "reference/.devbox/nix/profile/default/manifest.json",
    source: FINDING_IN_JSON,
    linted: false,
    why: "#203 itself: a nix profile manifest a `devbox run` inside `reference/` leaves behind. `.gitignore` carries `.devbox/`, which matches at any depth; the root-anchored `!.devbox` this replaced did not.",
  },
  {
    path: ".scratch/prototype.ts",
    source: FINDING_IN_TYPESCRIPT,
    linted: false,
    why: "AGENTS.md hands `.scratch/` to agents as scratch space and `.gitignore` carries it, so a prototype left there is not source. `includes` never excluded it, and the gate linted it.",
  },
  {
    path: "packages/core/dist/index.js",
    source: FINDING_IN_TYPESCRIPT,
    linted: false,
    why: "`!**/dist` came out of `includes` on the strength of `.gitignore` carrying `dist/`. This is where that strength is checked.",
  },
  {
    path: ".claude/worktrees/another-branch/biome.json",
    source: FINDING_IN_JSON,
    linted: false,
    why: "An agent harness puts a whole second checkout here, `biome.json` and all — and a nested root configuration is one Biome refuses outright, naming a directory you are not in, so this does not merely widen the scan: it makes `devbox run lint` fail in the checkout that has one.",
  },
  {
    path: "packages/core/openapi.json",
    source: FINDING_IN_JSON,
    linted: false,
    why: "A generated artifact that is *tracked*, so no ignore file can ever exclude it. This is the half `includes` still carries, and it has to keep working.",
  },
  {
    path: "src/ordinary.ts",
    source: FINDING_IN_TYPESCRIPT,
    linted: true,
    why: "An ordinary tracked source file. If the gate cannot see this one it is looking at nothing, and every assertion below would pass for the wrong reason.",
  },
];

/**
 * Biome, run over a throwaway tree carrying the repository's own `biome.json` and `.gitignore`.
 *
 * Both files are copied verbatim rather than reconstructed, because the subject is what those
 * two say *together*. The tree is a copy rather than the checkout itself for one reason worth
 * keeping: writing `.scratch/prototype.ts` into the working tree would land in the directory
 * agents are told to use, and a crashed run would take somebody's work out with its cleanup.
 *
 * No `.git` is created and none is needed — Biome reads the ignore file itself. It *does* fail
 * outright when `useIgnoreFile` is on and there is no ignore file beside the config, which is
 * why the copy is not optional.
 */
async function lintFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kobai-lint-scope-"));
  try {
    for (const name of ["biome.json", ".gitignore"]) {
      await writeFile(join(dir, name), await readFile(join(repoRoot, name), "utf8"));
    }
    for (const { path, source } of FIXTURE) {
      const file = join(dir, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    try {
      const { stdout } = await run(
        biomeBin,
        ["ci", dir, "--config-path", dir, "--reporter=summary", "--colors=off"],
        { cwd: dir },
      );
      return stdout;
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `biome.json` is read with `JSON.parse` and not with `jsonc-parser`, which is what this
 * repository otherwise reaches for. A comment in `biome.json` stops Biome parsing its own
 * config (ADR-0039), so the one file that cannot be JSONC is this one — reading it as JSONC
 * would accept a file the tool it configures rejects.
 */
type BiomeConfig = { files?: { includes?: string[] } };

describe("what the gate lints", () => {
  it("sees every tracked source file and nothing git ignores", async () => {
    const report = await lintFixture();

    for (const { path, linted, why } of FIXTURE) {
      expect(
        report.includes(path),
        `${path} should ${linted ? "" : "not "}be linted. ${why}\n\nBiome reported:\n${report}`,
      ).toBe(linted);
    }
  });

  /**
   * The other half of ADR-0068, and the one a fixture cannot ask.
   *
   * An exclusion for something git already ignores is a second answer to a question
   * `.gitignore` has answered — the arrangement that produced #203, where the second answer
   * was the narrower one and nobody could see it. So every path `includes` excludes has to be
   * a path git **tracks**: that is the only kind an ignore file can never reach, and it is
   * therefore the only kind that belongs here.
   */
  it("excludes only files git tracks", async () => {
    const config = JSON.parse(
      await readFile(join(repoRoot, "biome.json"), "utf8"),
    ) as BiomeConfig;
    const excluded = (config.files?.includes ?? [])
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1));

    expect(excluded.length).toBeGreaterThan(0);

    for (const pattern of excluded) {
      const { stdout } = await run(
        "git",
        ["ls-files", "--", `:(glob)${pattern}`, `:(glob)${pattern}/**`],
        { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 },
      );
      expect(
        stdout.trim(),
        `biome.json excludes "${pattern}", which git tracks no file under. An exclusion for something git ignores is a second, narrower answer to what .gitignore already says — put it there instead, and let vcs.useIgnoreFile carry it at every depth (ADR-0068, #203).`,
      ).not.toBe("");
    }
  });
});
