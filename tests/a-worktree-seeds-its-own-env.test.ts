import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureEnv, fill } from "../scripts/ensure-env.ts";
import { derivePorts } from "../scripts/ports.ts";
import { removeAll } from "./support/removal.ts";

/**
 * A linked worktree gets a `.env` of its own, once, and nothing else does (ADR-0084).
 *
 * The seeding is what makes a derived port *legible* and what makes it reach `docker
 * compose` at all: compose reads `.env` itself, so a hand-typed `docker compose up db`
 * lands on the same container the scripts do. The old arrangement exported the ports into
 * each script's environment, and the two disagreed.
 */

const EXAMPLE = [
  "# Every environment variable kobai reads.",
  "POSTGRES_USER=kobai",
  "POSTGRES_PASSWORD=kobai",
  "# POSTGRES_PORT=55432",
  "",
  "# Port the application listens on.",
  "# PORT=3000",
  "",
  "# COMPOSE_PROJECT_NAME=kobai",
  "",
].join("\n");

const made: string[] = [];

// Through `removeAll` rather than a `for` loop of `rmSync`, because most of what is made
// here is a git repository this file committed into — see that module for what is still
// writing in one, and why abandoning the rest at the first path that throws was half the bug
// (#313).
afterAll(() => removeAll(made));

const git = (cwd: string, ...argv: string[]) =>
  execFileSync("git", argv, { cwd, stdio: ["ignore", "ignore", "ignore"] });

/** A main checkout and a linked worktree of it, both holding an `.env.example`. */
function aCheckoutAndAWorktree(): { main: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "kobai-seeding-"));
  made.push(root);

  const main = join(root, "main");
  execFileSync("git", ["init", "-q", main], { stdio: ["ignore", "ignore", "ignore"] });
  git(main, "config", "user.email", "test@example.test");
  git(main, "config", "user.name", "test");
  writeFileSync(join(main, ".env.example"), EXAMPLE);
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "one");

  const worktree = resolve(root, "worktree");
  git(main, "worktree", "add", "-q", "--detach", worktree);

  return { main, worktree };
}

describe("filling the example in", () => {
  it("writes both ports, uncommenting the lines they were written on", () => {
    const filled = fill(EXAMPLE, { postgresPort: 55154, port: 53154 });

    expect(filled).toContain("\nPOSTGRES_PORT=55154\n");
    expect(filled).toContain("\nPORT=53154\n");
  });

  it("does not hand the application the database's port", () => {
    // Both names end in the same four letters, and a pattern anchored loosely enough to
    // match the longer one would fill `POSTGRES_PORT` in twice and leave `PORT` alone.
    const filled = fill(EXAMPLE, { postgresPort: 55154, port: 53154 });

    expect(filled).not.toContain("POSTGRES_PORT=53154");
    expect(filled.match(/^POSTGRES_PORT=/gm)).toHaveLength(1);
    expect(filled.match(/^PORT=/gm)).toHaveLength(1);
  });

  it("changes nothing else about the file", () => {
    const filled = fill(EXAMPLE, { postgresPort: 55154, port: 53154 });

    const untouched = (text: string) =>
      text
        .split("\n")
        .filter((line) => !/^#?[ \t]*(POSTGRES_)?PORT=/.test(line))
        .join("\n");

    expect(untouched(filled)).toBe(untouched(EXAMPLE));
  });

  it("refuses an example that declares no port line, rather than seeding a wrong one", () => {
    // The failure it prevents is a `.env` that looks seeded and carries whatever
    // `compose.yaml` falls back to — which is the disagreement all of this exists to remove.
    expect(() => fill("POSTGRES_USER=kobai\n", { postgresPort: 1, port: 2 })).toThrow(
      /POSTGRES_PORT/,
    );
  });
});

describe("who gets seeded", () => {
  it("seeds a worktree that has none, with the ports that worktree derives", () => {
    const { worktree } = aCheckoutAndAWorktree();

    expect(ensureEnv(worktree)).toBe("seeded");

    const written = readFileSync(join(worktree, ".env"), "utf8");
    const { postgresPort, port } = derivePorts(worktree);
    expect(written).toContain(`POSTGRES_PORT=${postgresPort}`);
    expect(written).toContain(`PORT=${port}`);
  });

  it("leaves a worktree that already has one exactly as it found it", () => {
    // Never over an existing file: it is a Developer's, and it may hold a real secret.
    const { worktree } = aCheckoutAndAWorktree();
    const mine = "POSTGRES_PORT=1234\nSTRIPE_SECRET_KEY=sk_live_something\n";
    writeFileSync(join(worktree, ".env"), mine);

    expect(ensureEnv(worktree)).toBe("already-present");
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe(mine);
  });

  it("does not seed a main checkout, which takes the ordinary ports", () => {
    const { main } = aCheckoutAndAWorktree();

    expect(ensureEnv(main)).toBe("not-a-worktree");
    expect(existsSync(join(main, ".env"))).toBe(false);
  });

  it("does not seed a directory that is no repository at all", () => {
    // A Docker build context is the case that matters: `Dockerfile` runs an install inside
    // the image, and this must be inert there rather than reaching for git.
    const nowhere = mkdtempSync(join(tmpdir(), "kobai-not-a-repo-"));
    made.push(nowhere);
    writeFileSync(join(nowhere, ".env.example"), EXAMPLE);

    expect(ensureEnv(nowhere)).toBe("not-a-worktree");
    expect(existsSync(join(nowhere, ".env"))).toBe(false);
  });

  it("gives two worktrees of one repository different ports", () => {
    const { main } = aCheckoutAndAWorktree();
    const second = resolve(main, "..", "second");
    git(main, "worktree", "add", "-q", "--detach", second);
    const first = resolve(main, "..", "worktree");

    ensureEnv(first);
    ensureEnv(second);

    const portsIn = (root: string) =>
      readFileSync(join(root, ".env"), "utf8").match(/^POSTGRES_PORT=(\d+)$/m)?.[1];

    expect(portsIn(first)).toBeDefined();
    expect(portsIn(second)).not.toBe(portsIn(first));
  });
});
