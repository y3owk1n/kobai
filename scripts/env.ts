import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The one place a database address is assembled, and the one place `.env` is read.
 *
 * **Parts, never a written-down URL.** `scripts/ensure-env.ts` seeds `POSTGRES_PORT` and
 * `PORT` and nothing else: a seeded `DATABASE_URL` would go stale the moment a Developer
 * changed `POSTGRES_PASSWORD` three lines above it, leaving a container with the new
 * password, an address with the old one, and an authentication failure naming neither. That
 * is #63, and ADR-0046's rule — one source decides where the container comes up *and* who it
 * lets in — is the half of it that survives into ADR-0084.
 *
 * There is no `.env` parser here. `process.loadEnvFile` is Node's own, it follows the same
 * grammar docker compose does, and it leaves a variable already in the environment alone —
 * so an explicit value still beats the file, which is the precedence this repository has
 * always had.
 */

/** The repository root, from this file rather than from a count of `..` segments. */
export const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Reads `.env` into `process.env`, if there is one.
 *
 * A checkout with no `.env` is the ordinary case, so its absence is not a failure —
 * `loadEnvFile` throws `ENOENT` and the caller wants the fallbacks instead.
 */
export function loadDotenv(root: string = repoRoot): void {
  const path = new URL(".env", `file://${root.endsWith("/") ? root : `${root}/`}`);
  if (!existsSync(path)) return;
  process.loadEnvFile(fileURLToPath(path));
}

export type PostgresParts = {
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly host: string;
  readonly port: number;
};

/**
 * Percent-encodes one value for the half of the URL it is going into.
 *
 * **The two halves are not the same, and `pg` is why.** It reads the user and the password
 * with `decodeURIComponent` and the database name — which travels in the path — with
 * `decodeURI`, and `decodeURI` never unescapes a reserved character. So an over-encoded `=`
 * in a database name arrives as a literal `%3D` and Postgres reports a database nobody
 * named. Encode against the driver, not against the RFC.
 */
export function encodeFor(half: "credential" | "path", value: string): string {
  return half === "credential" ? encodeURIComponent(value) : encodeURI(value);
}

/**
 * Builds a Postgres connection string from the parts, encoded per half.
 *
 * The `kobai` defaults are the same literals `compose.yaml` falls back to and the test
 * harness carries; `tests/the-postgres-credentials-belong-to-dot-env.test.ts` holds them
 * together, the way `tests/the-fallback-postgres-port.test.ts` holds the port.
 */
export function postgresUrl(
  port: number,
  source: Readonly<Record<string, string | undefined>> = process.env,
  host = "127.0.0.1",
): string {
  const parts: PostgresParts = {
    user: source.POSTGRES_USER ?? "kobai",
    password: source.POSTGRES_PASSWORD ?? "kobai",
    database: source.POSTGRES_DB ?? "kobai",
    host,
    port,
  };

  const credential = `${encodeFor("credential", parts.user)}:${encodeFor("credential", parts.password)}`;
  return `postgres://${credential}@${parts.host}:${parts.port}/${encodeFor("path", parts.database)}`;
}
