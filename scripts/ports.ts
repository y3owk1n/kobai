import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * The ports a checkout serves on, and whether this one is entitled to ports of its own.
 *
 * A normal checkout takes the fallbacks below and that is the whole story — `compose.yaml`
 * publishes `${POSTGRES_PORT:-55432}` and `${PORT:-3000}`, and `.env` overrides them, the way
 * every other repository works. **A linked git worktree is the exception**, because a harness
 * that runs work on a branch puts a whole second checkout in one and a gitignored `.env` does
 * not travel into it: sixteen worktrees would collide on 55432 until somebody wrote a file by
 * hand, and the failure — a container belonging to another branch, already up and healthy on
 * the port you wanted — wastes an afternoon before it names itself.
 *
 * So a worktree derives a pair from its own path and `scripts/ensure-env.ts` writes them into
 * a `.env` of its own, once. See ADR-0084.
 *
 * Nothing here reads the environment. That is deliberate: the derivation is the thing under
 * test, and a function that consulted `process.env` would answer differently under the gate —
 * which is exactly how this rule used to be untestable without shelling a config file.
 */

/**
 * What a checkout that derives nothing publishes on.
 *
 * **55432 rather than 5432, and that is not arbitrary**: a Developer's own Postgres should
 * not have to move. The application's 3000 has no such problem and is left where every
 * reader expects it. `compose.yaml` carries both as its own `${…:-}` fallbacks, and
 * `tests/the-fallback-postgres-port.test.ts` holds every copy of the first to one number.
 */
export const FALLBACK_POSTGRES_PORT = 55432;
export const FALLBACK_APPLICATION_PORT = 3000;

/**
 * The ranges a worktree derives into. Read each as the port the service is known by with a
 * `5` in front of it.
 */
export const POSTGRES_RANGE = { from: 55000, size: 1000 } as const;
export const APPLICATION_RANGE = { from: 53000, size: 1000 } as const;

export type DerivedPorts = {
  readonly postgresPort: number;
  readonly port: number;
};

/**
 * The pair a path derives, and the same pair every time.
 *
 * A path rather than a free port taken at random, because a container outlives the run that
 * started it: yesterday's has to still be findable at today's port. The two share the same
 * remainder on purpose — `53154` beside `55154` reads as one checkout in a `docker ps`
 * rather than as two unrelated stacks.
 */
export function derivePorts(path: string): DerivedPorts {
  const digest = createHash("sha256").update(resolve(path)).digest();
  const offset = digest.readUInt32BE(0) % POSTGRES_RANGE.size;

  return {
    postgresPort: POSTGRES_RANGE.from + offset,
    port: APPLICATION_RANGE.from + offset,
  };
}

/**
 * Whether this directory is a **linked** worktree rather than a main checkout.
 *
 * `git rev-parse` answers it in one call: in a linked worktree `--git-dir` is
 * `…/.git/worktrees/<name>` while `--git-common-dir` is `…/.git`; in a main checkout both
 * are the same directory. Anything that goes wrong — no git on PATH, not a repository at
 * all, a checkout exported as a tarball — answers `false`, because the fallbacks above are
 * what a checkout with no answer should get.
 *
 * Rejected: "a worktree, **or** the standard port is already bound". It would cover a second
 * *clone* as well, and it would make the port depend on what else happens to be running — so
 * two runs of the same command in the same directory could land differently, which is the
 * class of bug nobody can reproduce. A second clone takes the fallbacks and collides, which
 * is the collision every project has and has an answer every developer knows: write a `.env`.
 */
export function isLinkedWorktree(root: string): boolean {
  try {
    const printed = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--git-dir", "--git-common-dir"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    const [gitDir, commonDir] = printed.trim().split("\n");
    if (gitDir === undefined || commonDir === undefined) return false;

    return resolve(root, gitDir) !== resolve(root, commonDir);
  } catch {
    return false;
  }
}

/**
 * What this checkout should publish on: derived if it is a worktree, the fallbacks otherwise.
 */
export function portsFor(root: string): DerivedPorts {
  return isLinkedWorktree(root)
    ? derivePorts(root)
    : { postgresPort: FALLBACK_POSTGRES_PORT, port: FALLBACK_APPLICATION_PORT };
}
