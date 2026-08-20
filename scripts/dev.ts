import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadDotenv, postgresUrl, repoRoot } from "./env.ts";
import { portsFor } from "./ports.ts";

/**
 * The reference Project on this machine, against the Postgres in Docker — **watching**.
 *
 * Two loops, because an edit in this repository lands in one of two places and only one of
 * them used to be picked up:
 *
 * - **`tsc --watch` over every package the Project resolves at runtime.** Those resolve
 *   through their `exports` to `dist` — the same path a Developer outside this repository
 *   takes — so an edit to `packages/core/src` reaches the running Project only once it has
 *   been compiled. Without this, `pnpm run dev` served the build you started it with and
 *   nothing you did afterwards, which is a bad failure because it looks like your change did
 *   nothing rather than like nothing rebuilt it.
 * - **`node --watch` over the Project itself.** It restarts on any file it loaded, which
 *   includes those `dist` outputs, so the two compose: save a file in Core, tsc writes
 *   `dist`, Node notices and restarts.
 *
 * The Admin is deliberately not either of these. It is a browser bundle with its own reload
 * loop — `pnpm run admin:dev`, in a second terminal — and rebuilding it on every keystroke
 * here would be slower and worse than the dev server it already has.
 *
 * It also assembles one variable. `DATABASE_URL` is built from the parts at the moment it is
 * needed rather than written down anywhere, because a written-down URL goes stale the moment
 * the password above it changes (#63, ADR-0084). `.env` is read first and cannot overwrite
 * anything already in the environment, so an explicit one — a real database, a colleague's —
 * still wins.
 */

loadDotenv(repoRoot);

const port = Number(process.env.POSTGRES_PORT ?? portsFor(repoRoot).postgresPort);
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? postgresUrl(port),
};

const children = [
  spawn("pnpm", ["--filter", "@kobai/*", "--parallel", "run", "build:watch"], {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  }),
  spawn("node", ["--env-file-if-exists=.env", "--watch", "src/server.ts"], {
    cwd: join(repoRoot, "reference"),
    stdio: "inherit",
    env,
  }),
];

/** One of them exiting takes the other with it, so Ctrl-C leaves nothing behind. */
let stopping = false;
function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}

for (const child of children) {
  child.on("exit", (code, signal) => stopAll(signal === null ? (code ?? 0) : 0));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => stopAll(0));
}
