import { spawnSync } from "node:child_process";
import { loadDotenv, postgresUrl, repoRoot } from "./env.ts";
import { portsFor } from "./ports.ts";

/**
 * Runs the reference Project on this machine, against the Postgres in Docker.
 *
 * It exists to assemble one variable. `DATABASE_URL` used to be exported by devbox's
 * `init_hook` in front of every command; under ADR-0084 nothing exports it, because a
 * written-down URL goes stale the moment the password above it changes. So it is built here,
 * from the parts, at the moment it is needed — and only when nothing has already answered.
 *
 * `.env` is read first and cannot overwrite anything already in the environment, so an
 * explicit `DATABASE_URL` — pointing at a real database, or a colleague's — still wins.
 */

loadDotenv(repoRoot);

const port = Number(process.env.POSTGRES_PORT ?? portsFor(repoRoot).postgresPort);

const { status } = spawnSync("pnpm", ["--filter", "kobai-reference", "dev"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? postgresUrl(port),
  },
});

process.exit(status ?? 1);
