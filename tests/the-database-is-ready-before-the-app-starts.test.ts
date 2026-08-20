import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * The start-order race six agents' runs died on, asked of the file that causes it (#80).
 *
 * `app` already declared `depends_on: db: condition: service_healthy`, so the wiring was
 * never the fault — the question the healthcheck asks was. `pg_isready` with no host dials
 * the **unix socket**, and the official Postgres image initialises a fresh volume by
 * starting a *temporary* server on that socket with `listen_addresses=''`, running the init
 * scripts against it, shutting it down and starting the real one. Throughout that window
 * the socket answers "accepting connections" while nothing is listening on TCP at all. So
 * compose declared `db` healthy, released `app` against a server about to be shut down, and
 * the boot died on `CREATE SCHEMA IF NOT EXISTS "drizzle"` — a correct refusal (#2,
 * ADR-0031) caused by an incorrect assumption about readiness. Docker under contention
 * widens the window, which is why three worktrees found it and one run never could.
 *
 * So this pins a container in exactly that window — an init script that never returns — and
 * asks the healthcheck **taken out of the compose file** what it reports there. Reading the
 * file and asserting on the flags would prove nothing: the old command and the new one
 * differ by one, and the difference exists only for a Postgres mid-initialisation.
 */

const run = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

/** Pulling `postgres:18-alpine` on a cold runner, then initialising a database twice. */
const TIMEOUT = 300_000;

/**
 * The two compose files carrying this `db` service — the one a Developer receives, and the
 * one this repository's own suite runs against. Both had the defect, and a fix to one of
 * them is half a fix.
 *
 * The template's copy is deliberately absent: it is generated from `reference/`, and
 * `tests/create-kobai-matches-the-reference-project.test.ts` is what holds those in step.
 */
const COMPOSE_FILES = ["reference/compose.yaml", "compose.yaml"] as const;

/**
 * What the `db` service is given, and so what a `${…:-default}` in its healthcheck resolves
 * to. These are the compose files' own defaults. A healthcheck that began naming a variable
 * the service does not declare would expand differently here than under compose, and the
 * assertions below would be measuring a command nobody runs.
 */
const DATABASE_ENVIRONMENT = {
  POSTGRES_USER: "kobai",
  POSTGRES_PASSWORD: "kobai",
  POSTGRES_DB: "kobai",
} as const;

const IMAGE = "postgres:18-alpine";

/** The line the image prints once initialisation is behind it and the real server is next. */
const INITIALISED = "PostgreSQL init process complete";

type ComposeService = {
  healthcheck?: { test?: unknown } | null;
  depends_on?: Record<string, { condition?: string } | null> | null;
};
type ComposeFile = { services?: Record<string, ComposeService | null> | null };

async function composeFile(path: string): Promise<ComposeFile> {
  const contents = await readFile(fileURLToPath(new URL(path, repoRoot)), "utf8");
  return (parseYaml(contents) ?? {}) as ComposeFile;
}

/**
 * The `db` healthcheck, as an argv `docker exec` can run.
 *
 * Compose's `CMD-SHELL` form is `/bin/sh -c` and its bare-string form is the same thing, so
 * both arrive here as a shell invocation. `${POSTGRES_USER:-kobai}` is left in the string
 * rather than substituted: the shell inside the container expands it against the same
 * variables the service declares, which is where compose reads them from too.
 */
function healthcheckArgv(file: ComposeFile, path: string): string[] {
  const test = file.services?.db?.healthcheck?.test;

  if (typeof test === "string") return ["sh", "-c", test];
  if (Array.isArray(test)) {
    const [form, ...rest] = test as string[];
    if (form === "CMD-SHELL" && rest.length === 1 && rest[0] !== undefined) {
      return ["sh", "-c", rest[0]];
    }
    if (form === "CMD" && rest.length > 0) return rest;
  }

  // Failing open would be worse than failing: an unrecognised healthcheck would leave every
  // assertion below running some command this file invented.
  throw new Error(
    `${path} declares no \`db\` healthcheck this test recognises, so there is nothing here to hold to #80's rule. Expected \`test: ["CMD-SHELL", "…"]\`, \`["CMD", …]\` or a bare string.`,
  );
}

const started: string[] = [];

afterAll(async () => {
  await Promise.all(
    started.map((name) =>
      run("docker", ["rm", "--force", "--volumes", name]).catch(() => undefined),
    ),
  );
});

/** A name no concurrent checkout can collide with — several of them run this suite at once. */
function uniqueName(what: string): string {
  return `kobai-80-${what}-${randomBytes(6).toString("hex")}`;
}

/**
 * A Postgres on a fresh volume, optionally pinned in the middle of initialising one.
 *
 * The pin is the image's own mechanism rather than anything invented here: the entrypoint
 * runs every script in `/docker-entrypoint-initdb.d` against the temporary socket-only
 * server, so a script that never returns is a Postgres that never finishes starting. That
 * makes the window a first `docker compose up` passes through in a fraction of a second —
 * and lingers in on a loaded machine — durable enough to assert against, so this test is
 * about the healthcheck rather than about who won a race.
 *
 * Written by the container itself rather than mounted or baked in: the OS temp directory is
 * not shared with Docker Desktop by default, and a build would be a second thing to clean
 * up. `docker-entrypoint.sh` is then `exec`ed exactly as the image's own entrypoint does.
 */
async function startPostgres(options: {
  readonly stallInInit: boolean;
}): Promise<string> {
  const name = uniqueName(options.stallInInit ? "initialising" : "initialised");
  started.push(name);

  const environment = Object.entries(DATABASE_ENVIRONMENT).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`,
  ]);

  const entrypoint = options.stallInInit
    ? [
        "--entrypoint",
        "sh",
        IMAGE,
        "-c",
        "printf 'sleep 600\\n' > /docker-entrypoint-initdb.d/zz-stall.sh; exec docker-entrypoint.sh postgres",
      ]
    : [IMAGE];

  await run("docker", ["run", "--detach", "--name", name, ...environment, ...entrypoint]);
  return name;
}

/** Runs a command inside a container and reports its exit status, whatever that is. */
async function exitStatusOf(container: string, argv: readonly string[]): Promise<number> {
  try {
    await run("docker", ["exec", container, ...argv]);
    return 0;
  } catch (cause) {
    const { code } = cause as { code?: unknown };
    return typeof code === "number" ? code : 1;
  }
}

function logsOf(container: string): Promise<string> {
  return run("docker", ["logs", container]).then(({ stdout, stderr }) => stdout + stderr);
}

async function until(
  what: string,
  reached: () => Promise<boolean>,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reached()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Waited ${timeoutMs}ms and ${what} never happened.`);
}

describe("the compose files", () => {
  it("make `app` wait for `db` to report healthy, not merely to have started", async () => {
    for (const path of COMPOSE_FILES) {
      const { services } = await composeFile(path);

      expect(
        services?.app?.depends_on?.db?.condition,
        `${path}'s \`app\` no longer waits on \`db\`'s health, so it runs its migrations against whatever happens to be listening. That is #80.`,
      ).toBe("service_healthy");
    }
  });
});

describe("the `db` healthcheck", () => {
  it(
    "reports a Postgres that has not finished initialising as not accepting connections",
    async () => {
      const container = await startPostgres({ stallInInit: true });

      // The arrangement *is* the old healthcheck: wait until `pg_isready` over the socket
      // says the database is accepting connections. That moment is precisely when compose
      // used to declare `db` healthy and release `app` — against a temporary server with no
      // TCP listener, which is then shut down and restarted.
      await until(
        "the temporary server accepted a socket connection",
        async () =>
          (await exitStatusOf(container, [
            "pg_isready",
            "-U",
            DATABASE_ENVIRONMENT.POSTGRES_USER,
            "-d",
            DATABASE_ENVIRONMENT.POSTGRES_DB,
          ])) === 0,
      );

      expect(
        await logsOf(container),
        "The container finished initialising, so it is no longer pinned in the window this test is about and the assertion below would pass for the wrong reason.",
      ).not.toContain(INITIALISED);

      // Each file's own healthcheck, against the one container. Both carried the defect and
      // neither is generated from the other, so each is held to the property separately —
      // rather than to being byte-identical, which they are free to stop being.
      for (const path of COMPOSE_FILES) {
        const healthcheck = healthcheckArgv(await composeFile(path), path);

        expect(
          await exitStatusOf(container, healthcheck),
          `${path}'s \`db\` healthcheck reports a Postgres that is still initialising as ready. Compose will release \`app\` against a server it cannot reach, \`app\` will run its migrations into it, and the boot will die on \`CREATE SCHEMA IF NOT EXISTS "drizzle"\` — #80. The healthcheck has to ask over the transport \`app\` dials, not over the unix socket the image's temporary init server listens on.`,
        ).not.toBe(0);
      }
    },
    TIMEOUT,
  );

  it(
    "reports a Postgres that has finished initialising as accepting connections",
    async () => {
      // The other direction, and the reason it is not enough on its own: a healthcheck that
      // answered "no" forever would pass the test above and never let a Developer boot.
      const container = await startPostgres({ stallInInit: false });

      for (const path of COMPOSE_FILES) {
        const healthcheck = healthcheckArgv(await composeFile(path), path);

        await until(
          `${path}'s \`db\` healthcheck reported the database ready`,
          async () => (await exitStatusOf(container, healthcheck)) === 0,
        );
      }

      // …and it did not say so early. The first "ready" either healthcheck gives is after
      // the image says initialisation is behind it, which is the property #80 asked for.
      expect(await logsOf(container)).toContain(INITIALISED);
    },
    TIMEOUT,
  );
});
