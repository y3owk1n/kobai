import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { readDevbox } from "./support/init-hook.ts";

/**
 * A checkout that has never installed is an ordinary state, and every command has to say so.
 *
 * `devbox run lint` and `devbox run format` failed there with `Command "biome" not found` —
 * a message that names a binary and leaves the reader to work out that a package manager
 * never ran. It landed on the worst possible command: AGENTS.md § Development tells a reader
 * to reach for `devbox run format` first, because it rewrites rather than reports. And the
 * state is not rare — a fresh clone, a `git worktree add`, an agent's worktree (#133).
 *
 * **A generated Project is that state by definition** (#139): it is the only state it has
 * ever been in, its Developer has no `devbox run ci` in muscle memory and no repository in
 * front of them, and the binary the failure named was one they had never heard of. So the
 * guard ships into the Project too, and the trees below are swept alike — the workspace's,
 * the reference Project's, and the copy of the Project's that `create-kobai` publishes.
 *
 * Every script that runs a binary out of `node_modules` opens with
 * `sh scripts/require-install.sh <its own name> &&`. Four things have to hold, and they are
 * different questions:
 *
 * - **What the guard does**, which only running it can answer. The real file is run against
 *   a directory standing in for a checkout, with `node_modules` there or not.
 * - **Which scripts have it.** The sweep derives the list from each `devbox.json` rather than
 *   listing it here, so the next script to run pnpm is covered without an edit — which is
 *   what stops the fix being applied only to the scripts that happened to be noticed.
 * - **That the copies have not drifted.** There are two guards in this repository and a third
 *   generated from one of them, and only their *words* may differ: see `the same guard, in
 *   every tree that ships one` below.
 * - **That a script depends on nothing the `init_hook` defines.** That one is the mistake
 *   this file was written after making: see `no script calls a function the init_hook
 *   defines` below.
 */

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** The guard, where every `devbox.json` in this repository says it is — its own root. */
const GUARD = "scripts/require-install.sh";

/**
 * What a script that needs no guard runs instead. A script carrying this *is* the install —
 * guarding it would leave a fresh checkout with no way in at all.
 */
const INSTALLS = "pnpm install";

/**
 * The binaries these scripts reach for. None of them may appear in a refusal: naming one is
 * exactly what the failure this replaces did, and the reader who most needs the message is
 * the one who has never heard of the binary.
 */
const BINARIES = ["biome", "vitest", "tsc", "vite", "drizzle-kit"];

/** How a guarded script opens. The name it passes is what the message says failed. */
const guardFor = (name: string) => `sh ${GUARD} ${name} && `;

/**
 * A tree that ships the guard, and the words its own reader is owed.
 *
 * The three are not one file: kobai's own refusal names `devbox run ci` and this file's
 * §Development, and a Developer's Project has neither — it has `devbox run up`, which needs
 * nothing installed at all because the install happens inside the image. What they do share
 * is the mechanism, held below.
 */
type Tree = {
  /** How a failure names it. */
  readonly what: string;
  /** Where its root sits in this repository, or `"."` for the workspace's own. */
  readonly root: string;
  /** The scripts that are the install, and so carry no guard. */
  readonly installs: readonly string[];
  /** What its refusal has to say, which is what its own reader can act on. */
  readonly says: readonly string[];
};

const TREES: readonly Tree[] = [
  {
    what: "the workspace",
    root: ".",
    installs: ["ci", "install"],
    says: ["devbox run install", "devbox run ci", "AGENTS.md"],
  },
  {
    what: "the reference Project",
    root: "reference",
    installs: ["install"],
    says: ["devbox run install", "devbox run up"],
  },
  {
    // The bytes a Developer actually receives, rather than the ones they are generated from.
    // `tests/create-kobai-matches-the-reference-project.test.ts` holds the two together and
    // packs them into a tarball; this asks the shipped copy the same questions as the rest.
    what: "the Project a Developer receives",
    root: "packages/create-kobai/template",
    installs: ["install"],
    says: ["devbox run install", "devbox run up"],
  },
];

/** A path inside a tree, as this repository holds it. */
const at = (tree: Tree, relative: string) =>
  tree.root === "." ? relative : `${tree.root}/${relative}`;

async function scripts(tree: Tree): Promise<Record<string, string>> {
  const { shell } = await readDevbox(at(tree, "devbox.json"));
  const declared = shell?.scripts ?? {};
  if (Object.keys(declared).length === 0) {
    // Failing open would be worse than failing: an empty list makes the sweeps below pass by
    // examining nothing, which is indistinguishable from examining everything.
    throw new Error(
      `${at(tree, "devbox.json")} declares no \`shell.scripts\`, so no command was checked for the fresh-checkout guard.`,
    );
  }
  return declared;
}

const guardSource = (tree: Tree) => readFile(join(repoRoot, at(tree, GUARD)), "utf8");

/**
 * Runs a tree's guard the way its devbox scripts do, and reports how it went rather than
 * throwing — refusing is the behaviour under test.
 *
 * `env` is `PATH` and `DEVBOX_PROJECT_ROOT` and nothing else. Everything devbox exported
 * before vitest started is deliberately left out: this process is running inside a checkout
 * that *has* installed, and inheriting that would decide the answer. The working directory
 * is this repository, which has a `node_modules` of its own — so a guard that consulted the
 * directory it happened to be run from instead of the root it was told about would pass the
 * refusal below rather than fail it.
 */
async function guard(
  tree: Tree,
  root: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("sh", [at(tree, GUARD), "build"], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", DEVBOX_PROJECT_ROOT: root },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

let checkouts: string | undefined;

/** A directory standing in for a checkout, with `node_modules` there or not. */
async function checkout(installed: boolean): Promise<string> {
  checkouts ??= await mkdtemp(join(tmpdir(), "kobai-fresh-checkout-"));
  const root = await mkdtemp(join(checkouts, "checkout-"));
  if (installed) await mkdir(join(root, "node_modules"));
  return root;
}

afterAll(async () => {
  if (checkouts !== undefined) await rm(checkouts, { recursive: true, force: true });
  checkouts = undefined;
});

describe.each(TREES)("the guard $what ships", (tree) => {
  it("refuses, and names the command and what to run instead", async () => {
    const { code, stderr } = await guard(tree, await checkout(false));

    expect(code).not.toBe(0);
    // Everything the old failure left the reader to work out: the command that could not
    // run, the reason it could not, and what fixes it — in the words this tree's own reader
    // can act on, which is not the same sentence in a repository and in a Project.
    expect(stderr).toContain("devbox run build");
    for (const said of tree.says) expect(stderr).toContain(said);
    // No binary is named, because naming one is what the old failure did.
    for (const binary of BINARIES) expect(stderr).not.toContain(binary);
  });

  it("says nothing at all once the checkout has installed", async () => {
    const { code, stdout, stderr } = await guard(tree, await checkout(true));

    // A guard that spoke on the ordinary path would be noise in front of every command.
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("guards every script that runs pnpm without installing first", async () => {
    // Derived rather than listed. A script that reaches for pnpm reaches for something in
    // `node_modules`; the exceptions are the scripts that *put* it there. Anything else —
    // `db`, `up`, `down` — is docker only and needs nothing installed at all.
    const needsGuard = Object.entries(await scripts(tree)).filter(
      ([, command]) =>
        /\b(pnpm|npx)\b|node_modules\//.test(command) && !command.includes(INSTALLS),
    );
    const unguarded = needsGuard.filter(
      ([name, command]) => !command.startsWith(guardFor(name)),
    );

    expect(
      unguarded.map(([name, command]) => `${name}: ${command}`),
      `Each of these runs something out of node_modules with nothing checking there is one, so in a checkout that has never installed it fails naming a binary rather than the install. Open it with \`sh ${GUARD} <its own name> &&\`.`,
    ).toEqual([]);
    // An empty list would make the assertion above pass by examining nothing.
    expect(needsGuard.length).toBeGreaterThan(0);
  });

  it("leaves the scripts that install unguarded, so a fresh checkout has a way in", async () => {
    // `devbox run install` is the command the refusal tells a reader to run, and in the
    // workspace `devbox run ci` is the other. A guard on either would refuse the way out of
    // the state it exists to report, and a fresh checkout would have nothing it could run.
    const installing = Object.entries(await scripts(tree)).filter(([, command]) =>
      command.includes(INSTALLS),
    );

    expect(installing.map(([name]) => name).sort()).toEqual([...tree.installs].sort());
    expect(
      installing.filter(([, command]) => command.includes(GUARD)).map(([name]) => name),
    ).toEqual([]);
  });

  it("names itself in its own guard", async () => {
    // The name the guard is passed is the one the failure prints, so a copied-and-pasted
    // prefix would tell a reader to fix a command they did not run.
    const misnamed = Object.entries(await scripts(tree))
      .filter(([, command]) => command.startsWith(`sh ${GUARD} `))
      .filter(([name, command]) => !command.startsWith(guardFor(name)));

    expect(misnamed.map(([name, command]) => `${name}: ${command}`)).toEqual([]);
  });
});

/**
 * The two lines of a guard that carry its words, and the only two a copy may differ in.
 *
 * They are shell assignments rather than text inside the `printf` so that the difference has
 * a shape the comparison below can name — and so that a copy cannot quietly grow a second
 * difference by writing its words somewhere else.
 */
const WORDS = /^(fix|note)=/;

/**
 * Every line of a guard that is neither a comment, a blank, nor one of its two words — which
 * is to say the check itself.
 *
 * A comment is left out because each copy explains itself to its own reader: kobai's names
 * the issue and the devbox behaviour behind it, and a Project's has no reason to carry
 * either. So what is held identical here is what the guard *does*, and nothing claims more.
 */
const mechanismOf = (source: string) =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !WORDS.test(line));

/** The guard this repository's own commands run, which the others are compared against. */
async function workspaceGuard(): Promise<string> {
  const [workspace] = TREES;
  if (workspace === undefined) throw new Error("No tree ships a guard to compare.");
  return guardSource(workspace);
}

describe("the same guard, in every tree that ships one", () => {
  it("runs the same check in every tree, whatever each copy says", async () => {
    // The cost of shipping the guard into the Project is a second copy of it, and the ticket
    // that asked for it named the risk: two files nothing compares drift apart, and the drift
    // is invisible because each tree only ever tests its own (#139). So the check is compared
    // line for line, and a fix made in one copy and not the other fails here naming the line.
    // The words and the comments are each copy's own, and the claim is no wider than that.
    //
    // Not a byte comparison, because the two are deliberately not byte-identical: kobai's
    // refusal points at AGENTS.md and at `devbox run ci`, and a Project has neither. A
    // comparison that forced them together would have made one of the two messages false,
    // which is the failure this whole file exists to remove.
    const workspace = await workspaceGuard();

    for (const tree of TREES.slice(1)) {
      expect(
        mechanismOf(await guardSource(tree)),
        `${at(tree, GUARD)} no longer runs the same check as ${GUARD}. Only \`fix\`, \`note\` and the comments may differ between the copies — every other line is the mechanism, and a difference in it is one of them having been fixed alone.`,
      ).toEqual(mechanismOf(workspace));
    }

    // An empty mechanism would make the comparison above pass by comparing nothing.
    expect(mechanismOf(workspace).length).toBeGreaterThan(0);
  });

  it("keeps its words in those two lines, in every copy", async () => {
    // Which is what stops a copy evading the comparison by writing its sentences into the
    // `printf` itself, where they would read as mechanism and be held identical for as long
    // as nobody changed them.
    for (const tree of TREES) {
      const words = (await guardSource(tree))
        .split("\n")
        .filter((line) => WORDS.test(line));

      expect(
        words.map((line) => line.split("=")[0]),
        `${at(tree, GUARD)} does not carry exactly one \`fix\` and one \`note\` line`,
      ).toEqual(["fix", "note"]);
    }
  });

  it("reports a copy whose check was changed alone", async () => {
    // The red case, so the comparison is known to be able to fail rather than assumed to be.
    // This is the shape the drift would actually take: a real fix — here, a guard that stops
    // asking `DEVBOX_PROJECT_ROOT` where the checkout is — applied to one copy only.
    const workspace = await workspaceGuard();
    const drifted = workspace.replace(/^root=.*$/m, "root=$PWD");

    expect(drifted).not.toEqual(workspace);
    expect(mechanismOf(drifted)).not.toEqual(mechanismOf(workspace));
  });

  it("reads a copy whose only difference is its words as no drift at all", async () => {
    // The green case for the same comparison: rewriting what a Project's refusal says must
    // not fail a check about what it does.
    const workspace = await workspaceGuard();
    const reworded = workspace.replace(/^note=.*$/m, "note='Something else entirely.'");

    expect(reworded).not.toEqual(workspace);
    expect(mechanismOf(reworded)).toEqual(mechanismOf(workspace));
  });
});

describe("a script may depend on nothing the init_hook defines", () => {
  it("calls no function the init_hook declares", async () => {
    // The guard was a shell function in the `init_hook` first, and every script called it.
    // That is broken, invisibly: devbox generates one script per key and has it source the
    // hook **only** when `__DEVBOX_SKIP_INIT_HOOK_<hash>` is unset — so inside `devbox shell`,
    // the second way AGENTS.md says to run these commands, the hook never runs and every
    // guarded script died at 127 with `kobai_require_install: command not found`. An exported
    // *variable* survives into that child shell, which is why the port derivation in the same
    // hook never showed this and why the whole suite stayed green.
    //
    // So the rule is the one that failure teaches: the hook may export variables a script
    // reads, and may define functions for its own lines, but a script may call none of them.
    // Swept in every tree, though only the workspace's hook declares any today — a Project's
    // hook growing one is exactly when this would matter and nobody would think to look.
    const reaching: string[] = [];
    let declaredAnywhere = 0;

    for (const tree of TREES) {
      const { shell } = await readDevbox(at(tree, "devbox.json"));
      const declared = (shell?.init_hook ?? []).flatMap(
        (line) => /^\s*([A-Za-z_][\w]*)\s*\(\)\s*\{/.exec(line)?.slice(1, 2) ?? [],
      );
      declaredAnywhere += declared.length;

      for (const [name, command] of Object.entries(await scripts(tree))) {
        for (const fn of declared) {
          if (new RegExp(`\\b${fn}\\b`).test(command)) {
            reaching.push(`${at(tree, "devbox.json")}: ${name} calls ${fn}`);
          }
        }
      }
    }

    // Two today. None at all would make the sweep above pass by looking for nothing.
    expect(declaredAnywhere).toBeGreaterThan(0);

    expect(
      reaching,
      "devbox sources the init_hook only when a devbox shell is not already active, so a script calling a function it defines fails at 127 inside `devbox shell`. Put what the script needs in a file it runs, the way scripts/require-install.sh is.",
    ).toEqual([]);
  });
});
