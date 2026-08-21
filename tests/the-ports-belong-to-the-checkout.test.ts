import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  APPLICATION_RANGE,
  derivePorts,
  FALLBACK_APPLICATION_PORT,
  FALLBACK_POSTGRES_PORT,
  isLinkedWorktree,
  POSTGRES_RANGE,
  portsFor,
} from "../scripts/ports.ts";
import { removeAll } from "./support/removal.ts";

/**
 * Which checkouts get ports of their own, and which get the ordinary ones.
 *
 * A normal checkout takes `compose.yaml`'s fallbacks and that is the whole story. A **linked
 * git worktree** is the exception: a harness that runs work on a branch puts a whole second
 * checkout in one, a gitignored `.env` does not travel into it, and sixteen of them would
 * collide on 55432 until somebody wrote a file by hand (ADR-0084).
 *
 * This used to be tested by reading `devbox.json`'s `init_hook` and handing its lines to
 * `sh`, because that was the only place the rule existed. It is a pure function now, so this
 * is an ordinary unit test — which is the point of having moved it.
 */

/** Two checkouts, written down rather than made: the derivation only hashes the path. */
const ONE_CHECKOUT = "/checkouts/kobai";
const ANOTHER_CHECKOUT = "/checkouts/kobai-worktree";

const made: string[] = [];

// Through `removeAll` rather than a `for` loop of `rmSync`, because most of what is made
// here is a git repository this file committed into — see that module for what is still
// writing in one, and why abandoning the rest at the first path that throws was half the bug
// (#313).
afterAll(() => removeAll(made));

/** A real git repository on disk, and optionally a linked worktree of it. */
function aRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "kobai-worktree-"));
  made.push(root);

  const main = join(root, "main");
  execFileSync("git", ["init", "-q", main], { stdio: ["ignore", "ignore", "ignore"] });

  const inMain = (...argv: string[]) =>
    execFileSync("git", argv, { cwd: main, stdio: ["ignore", "ignore", "ignore"] });
  inMain("config", "user.email", "test@example.test");
  inMain("config", "user.name", "test");
  // A worktree cannot be added to a repository with no commits.
  inMain("commit", "-q", "--allow-empty", "-m", "one");

  return main;
}

describe("the ports a worktree derives", () => {
  it("gives the application a port of its own, in the range AGENTS.md promises", () => {
    const { port } = derivePorts(ONE_CHECKOUT);

    expect(port).toBeGreaterThanOrEqual(APPLICATION_RANGE.from);
    expect(port).toBeLessThan(APPLICATION_RANGE.from + APPLICATION_RANGE.size);
  });

  it("keeps the database in its own range, well clear of the application's", () => {
    const { postgresPort } = derivePorts(ONE_CHECKOUT);

    expect(postgresPort).toBeGreaterThanOrEqual(POSTGRES_RANGE.from);
    expect(postgresPort).toBeLessThan(POSTGRES_RANGE.from + POSTGRES_RANGE.size);
  });

  it("derives both ports from one number, so a `docker ps` reads as one checkout", () => {
    const { port, postgresPort } = derivePorts(ONE_CHECKOUT);

    expect(
      port - APPLICATION_RANGE.from,
      "The two ports no longer share their last three digits, so 53154 beside 55154 no longer reads as one checkout. Both are meant to come from the same hash.",
    ).toBe(postgresPort - POSTGRES_RANGE.from);
  });

  it("gives a second checkout different ports, with nothing passed by hand", () => {
    // The whole reason this exists: the collision one worktree hits when another is already
    // serving.
    const one = derivePorts(ONE_CHECKOUT);
    const another = derivePorts(ANOTHER_CHECKOUT);

    expect(another.port).not.toBe(one.port);
    expect(another.postgresPort).not.toBe(one.postgresPort);
  });

  it("gives one checkout the same ports every time", () => {
    // Why the path is hashed rather than a free port taken: a container outlives the run
    // that started it, and yesterday's has to still be findable today.
    expect(derivePorts(ONE_CHECKOUT)).toEqual(derivePorts(ONE_CHECKOUT));
  });

  it("does not care whether the path was written with a trailing slash", () => {
    // The hash is of a *string*, so a trailing slash would otherwise be a different checkout
    // — silently, and agreeing with itself wherever both sides asked the same way.
    expect(derivePorts(`${ONE_CHECKOUT}/`)).toEqual(derivePorts(ONE_CHECKOUT));
  });
});

describe("which checkouts derive at all", () => {
  it("says a main checkout is not a linked worktree", () => {
    expect(isLinkedWorktree(aRepository())).toBe(false);
  });

  it("says a linked worktree is one", () => {
    const main = aRepository();
    const linked = join(main, "..", "linked");
    execFileSync("git", ["worktree", "add", "-q", "--detach", linked], {
      cwd: main,
      stdio: ["ignore", "ignore", "ignore"],
    });

    expect(isLinkedWorktree(resolve(linked))).toBe(true);
  });

  it("says no when there is no repository at all", () => {
    // A tarball, a Docker build context, a directory somebody copied. The fallbacks are what
    // a checkout with no answer should get, so this must not throw.
    const nowhere = mkdtempSync(join(tmpdir(), "kobai-not-a-repo-"));
    made.push(nowhere);

    expect(isLinkedWorktree(nowhere)).toBe(false);
  });

  it("gives a main checkout the ordinary ports", () => {
    expect(portsFor(aRepository())).toEqual({
      postgresPort: FALLBACK_POSTGRES_PORT,
      port: FALLBACK_APPLICATION_PORT,
    });
  });
});

describe("the ordinary ports", () => {
  it("keeps the database off 5432, so a Developer's own Postgres need not move", () => {
    expect(FALLBACK_POSTGRES_PORT).not.toBe(5432);
  });

  it("leaves the application on the port every reader expects", () => {
    expect(FALLBACK_APPLICATION_PORT).toBe(3000);
  });
});
