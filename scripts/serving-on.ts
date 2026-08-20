import { loadDotenv, repoRoot } from "./env.ts";
import { portsFor } from "./ports.ts";

/**
 * Prints where `up` is about to serve, between the build output and the log stream.
 *
 * A derived database port needs no announcement — the harness dials it and `docker ps` has
 * it for anyone who wants it — but a Developer opens the application in a browser, and in a
 * worktree the port is not the 3000 they would otherwise assume.
 *
 * It reads `.env` for the same reason `compose.yaml` does, and falls back the same way. An
 * address printed from a different source than the one compose publishes on would be worse
 * than no address at all.
 */

loadDotenv(repoRoot);

const port = process.env.PORT ?? String(portsFor(repoRoot).port);

process.stdout.write(
  `\n  kobai is serving on http://localhost:${port} — health at /health, the Admin at /admin-ui\n\n`,
);
