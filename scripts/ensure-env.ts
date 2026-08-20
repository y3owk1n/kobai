import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./env.ts";
import { type DerivedPorts, derivePorts, isLinkedWorktree } from "./ports.ts";

/**
 * Gives a linked worktree a `.env` of its own, once, and does nothing anywhere else.
 *
 * Chained onto the commands that bring something up — `node scripts/ensure-env.ts && …` on
 * `up`, `db`, `dev`, `test` and `ci`. **Not a `postinstall`**: `Dockerfile` runs
 * `pnpm install --frozen-lockfile` inside the image build, where there may be neither `git`
 * nor `.git`, and a wrong port is a much better failure than a broken image. **Not a `pre*`
 * script** either: pnpm leaves `enable-pre-post-scripts` off by default, so one would
 * silently never run.
 *
 * **It seeds a file rather than exporting variables, and that is the point.** The old
 * arrangement exported the derived ports into each script's environment, so `pnpm run db`
 * and a hand-typed `docker compose up db` in the same directory brought up two different
 * stacks — the script's derived port against `compose.yaml`'s literal. Compose reads `.env`
 * itself, so a seeded file makes the two agree, and makes the values legible: you read them
 * rather than reasoning about a hash. See ADR-0084.
 */

/** What a run did, for the caller and for the test. */
export type Seeding = "seeded" | "already-present" | "not-a-worktree";

/**
 * The two lines this fills in, and nothing else.
 *
 * Anchored so that `PORT` cannot match `POSTGRES_PORT`: both names end in the same four
 * letters, and a reader anchored loosely enough to match the longer one would hand the
 * application the database's port. Each accepts the line commented or not, because
 * `.env.example` may one day stop commenting them out.
 */
const FILLS = [
  { name: "POSTGRES_PORT", pattern: /^#?[ \t]*POSTGRES_PORT=.*$/m },
  { name: "PORT", pattern: /^#?[ \t]*PORT=.*$/m },
] as const;

/**
 * Rewrites `.env.example`'s text with the derived ports filled in.
 *
 * **A whole copy rather than the two lines that matter.** A minimal file is a trap: a
 * contributor who later wants a Stripe key does the documented thing — `cp .env.example
 * .env` — and silently destroys their worktree's ports, which is this whole mechanism's own
 * failure reintroduced by its own documentation. A whole copy means `.env` is the familiar
 * file, already complete, and nobody ever needs to overwrite it.
 */
export function fill(example: string, ports: DerivedPorts): string {
  const values: Record<string, number> = {
    POSTGRES_PORT: ports.postgresPort,
    PORT: ports.port,
  };

  return FILLS.reduce((text, { name, pattern }) => {
    if (!pattern.test(text)) {
      // Loudly, because the alternative is a `.env` that looks seeded and carries whatever
      // `compose.yaml` falls back to — the disagreement this exists to remove.
      throw new Error(
        `.env.example declares no \`${name}\` line, so a worktree's own port cannot be written into it. Add one — commented out is fine — or this seeding is silently doing nothing.`,
      );
    }
    return text.replace(pattern, `${name}=${values[name]}`);
  }, example);
}

/** Seeds if this is a worktree with no `.env`. Never overwrites, never speaks otherwise. */
export function ensureEnv(root: string = repoRoot): Seeding {
  if (!isLinkedWorktree(root)) return "not-a-worktree";

  const dotenv = join(root, ".env");
  if (existsSync(dotenv)) return "already-present";

  const examplePath = join(root, ".env.example");
  const ports = derivePorts(root);
  writeFileSync(dotenv, fill(readFileSync(examplePath, "utf8"), ports));
  return "seeded";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? repoRoot;
  if (ensureEnv(root) === "seeded") {
    const { postgresPort, port } = derivePorts(root);
    process.stdout.write(
      `\n  This is a git worktree and had no .env, so one was written from .env.example.\n  Postgres is on ${postgresPort} and the application on ${port} — yours alone, and yours to edit.\n\n`,
    );
  }
}
