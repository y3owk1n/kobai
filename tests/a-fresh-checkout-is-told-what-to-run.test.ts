import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
 * Every script that runs a binary out of `node_modules` now opens with
 * `sh scripts/require-install.sh <its own name> &&`. Three things have to hold, and they are
 * different questions:
 *
 * - **What the guard does**, which only running it can answer. The real file is run against
 *   a directory standing in for a checkout, with `node_modules` there or not.
 * - **Which scripts have it.** The sweep derives the list from `devbox.json` rather than
 *   listing it here, so the next script to run pnpm is covered without an edit — which is
 *   what stops the fix being applied only to the two scripts that happened to be noticed.
 * - **That a script depends on nothing the `init_hook` defines.** That one is the mistake
 *   this file was written after making: see `no script calls a function the init_hook
 *   defines` below.
 */

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** The guard, where `devbox.json` says it is. */
const GUARD = "scripts/require-install.sh";

/**
 * What a script that needs no guard runs instead. A script carrying this *is* the install —
 * guarding it would leave a fresh checkout with no way in at all.
 */
const INSTALLS = "pnpm install";

/** How a guarded script opens. The name it passes is what the message says failed. */
const guardFor = (name: string) => `sh ${GUARD} ${name} && `;

async function scripts(): Promise<Record<string, string>> {
  const { shell } = await readDevbox();
  const declared = shell?.scripts ?? {};
  if (Object.keys(declared).length === 0) {
    // Failing open would be worse than failing: an empty list makes the sweeps below pass by
    // examining nothing, which is indistinguishable from examining everything.
    throw new Error(
      "devbox.json declares no `shell.scripts`, so no command was checked for the fresh-checkout guard.",
    );
  }
  return declared;
}

/**
 * Runs the guard the way a devbox script does, and reports how it went rather than throwing —
 * refusing is the behaviour under test.
 *
 * `env` is `PATH` and `DEVBOX_PROJECT_ROOT` and nothing else. Everything devbox exported
 * before vitest started is deliberately left out: this process is running inside a checkout
 * that *has* installed, and inheriting that would decide the answer.
 */
async function guard(
  root: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("sh", [GUARD, "lint"], {
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

describe("the guard in front of every command that needs an install", () => {
  it("refuses, and names the command, the install, and where the rest is written", async () => {
    const { code, stderr } = await guard(await checkout(false));

    expect(code).not.toBe(0);
    // Everything the old failure left the reader to work out. The command that could not
    // run, the reason it could not, and the two commands that fix it — one of which is the
    // gate, so a reader who runs it is where they wanted to be anyway.
    expect(stderr).toContain("devbox run lint");
    expect(stderr).toContain("devbox run install");
    expect(stderr).toContain("devbox run ci");
    expect(stderr).toContain("AGENTS.md");
    // No binary is named, because naming one is what the old failure did.
    expect(stderr).not.toContain("biome");
  });

  it("says nothing at all once the checkout has installed", async () => {
    const { code, stdout, stderr } = await guard(await checkout(true));

    // A guard that spoke on the ordinary path would be noise in front of every command.
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

describe("every command that needs an install carries the guard", () => {
  it("guards every script that runs pnpm without installing first", async () => {
    // Derived rather than listed. A script that reaches for pnpm reaches for something in
    // `node_modules`; the exceptions are the scripts that *put* it there. Anything else —
    // `db`, `up`, `down` — is docker only and needs nothing installed at all.
    const needsGuard = Object.entries(await scripts()).filter(
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
    // `devbox run ci` is the command the refusal tells a reader to run, and `devbox run
    // install` is the other. A guard on either would refuse the way out of the state it
    // exists to report, and a fresh checkout would have nothing at all it could run.
    const installing = Object.entries(await scripts()).filter(([, command]) =>
      command.includes(INSTALLS),
    );

    expect(installing.map(([name]) => name).sort()).toEqual(["ci", "install"]);
    expect(
      installing.filter(([, command]) => command.includes(GUARD)).map(([name]) => name),
    ).toEqual([]);
  });

  it("names itself in its own guard", async () => {
    // The name the guard is passed is the one the failure prints, so a copied-and-pasted
    // prefix would tell a reader to fix a command they did not run.
    const misnamed = Object.entries(await scripts())
      .filter(([, command]) => command.startsWith(`sh ${GUARD} `))
      .filter(([name, command]) => !command.startsWith(guardFor(name)));

    expect(misnamed.map(([name, command]) => `${name}: ${command}`)).toEqual([]);
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
    const { shell } = await readDevbox();
    const hook = shell?.init_hook ?? [];
    const declared = hook.flatMap(
      (line) => /^\s*([A-Za-z_][\w]*)\s*\(\)\s*\{/.exec(line)?.slice(1, 2) ?? [],
    );

    // Two today. An empty list would make the sweep below pass by looking for nothing.
    expect(declared.length).toBeGreaterThan(0);

    const reaching = Object.entries(await scripts()).flatMap(([name, command]) =>
      declared
        .filter((fn) => new RegExp(`\\b${fn}\\b`).test(command))
        .map((fn) => `${name} calls ${fn}`),
    );

    expect(
      reaching,
      "devbox sources the init_hook only when a devbox shell is not already active, so a script calling a function it defines fails at 127 inside `devbox shell`. Put what the script needs in a file it runs, the way scripts/require-install.sh is.",
    ).toEqual([]);
  });
});
