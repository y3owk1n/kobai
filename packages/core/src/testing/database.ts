import { randomBytes } from "node:crypto";
import pg from "pg";
import { quoteIdentifier } from "../db/identifier.ts";

/**
 * The Postgres a test suite talks to — the *maintenance* database, from which throwaway
 * ones are created, not a test database itself. Defaults to the `db` service in
 * `compose.yaml`.
 *
 * `KOBAI_TEST_DATABASE_URL` is not something kobai's own contributors set: `vitest.config.ts`
 * builds it from the same port and the same `POSTGRES_USER`, `POSTGRES_PASSWORD` and
 * `POSTGRES_DB` that `compose.yaml` reads, so where the container comes up and who it lets in
 * are both decided once and cannot drift apart (AGENTS.md § The ports belong to the
 * checkout). The literal below is the fallback for a suite run outside this repository — a
 * Project's own, under ADR-0047 — and every part of it matches `compose.yaml`'s own
 * fallbacks —
 * `tests/the-fallback-postgres-port.test.ts` holds the port to that and
 * `tests/the-postgres-credentials-belong-to-dot-env.test.ts` the credentials.
 *
 * "Maintenance" rather than "admin" throughout this module: in kobai, **Admin** means the
 * pre-built UI a Merchant works in, and nothing else (`CONTEXT.md`).
 */
export function testPostgresUrl(): string {
  return (
    process.env.KOBAI_TEST_DATABASE_URL ?? "postgres://kobai:kobai@127.0.0.1:55432/kobai"
  );
}

export type TestDatabase = {
  /** Connection string for the throwaway database. */
  readonly url: string;
  readonly name: string;
  /**
   * Runs one statement on a connection of its own, outside anything the application holds.
   * For arranging a database into a state the application cannot reach — a table already
   * squatting where a migration wants one — and for inspecting `information_schema`.
   */
  query<T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<T[]>;
  /** Drops it. Safe to call twice. */
  drop(): Promise<void>;
};

/**
 * Creates a throwaway Postgres database, and hands back the connection string for it.
 *
 * A whole database rather than a schema, because migrations are the thing under test:
 * a set tracks into `drizzle.__drizzle_migrations_*` and creates tables in `public`, and
 * anything that rewrote those locations to isolate tests would be testing something other
 * than what runs in production.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const maintenanceUrl = testPostgresUrl();
  const name = `kobai_test_${randomBytes(8).toString("hex")}`;

  await withMaintenanceClient(maintenanceUrl, (client) =>
    client.query(`create database ${quoteIdentifier(name)}`),
  );

  const url = replaceDatabase(maintenanceUrl, name);
  let dropped = false;
  return {
    url,
    name,
    async query<T extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const result = await client.query<T>(text, values);
        return result.rows;
      } finally {
        await client.end();
      }
    },
    async drop() {
      if (dropped) return;
      dropped = true;
      await withMaintenanceClient(maintenanceUrl, (client) =>
        // FORCE terminates anything still connected. A test that failed mid-request should
        // not leave a database behind for the next run to trip over.
        client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`),
      );
    },
  };
}

async function withMaintenanceClient<T>(
  maintenanceUrl: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: maintenanceUrl });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error(
      `Could not reach Postgres at ${redact(maintenanceUrl)}. The test suite needs a real one — bring it up with \`pnpm run db\`, or point KOBAI_TEST_DATABASE_URL somewhere else.`,
      { cause },
    );
  }
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function replaceDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "the configured URL";
  }
}
