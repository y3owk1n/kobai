import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { coreMigrationSet } from "@kobai/core/migrations";
import {
  appliedMigrations,
  createTestDatabase,
  declaredMigrations,
  type TestDatabase,
} from "@kobai/core/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import config from "../kobai.config.ts";

/**
 * The one seam that cannot be reached in-process: the process itself.
 *
 * Everything else in this repository dispatches HTTP straight at the application object.
 * "Exits non-zero" is not a property of an application object, so this spawns the real
 * entrypoint — the built artifact the Dockerfile runs — and watches what it does.
 */
const entrypoint = fileURLToPath(new URL("../dist/src/server.js", import.meta.url));

let child: ChildProcess | undefined;
let database: TestDatabase | undefined;

beforeAll(() => {
  if (!existsSync(entrypoint)) {
    throw new Error(
      `${entrypoint} does not exist. This test runs the shipped artifact rather than the source, so it needs a build first: \`devbox run build\` (or \`devbox run ci\`, which builds).`,
    );
  }
});

afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  await database?.drop();
  database = undefined;
});

describe("the reference Project's entrypoint", () => {
  it("boots, migrates, and serves health on the port it was given", async () => {
    database = await createTestDatabase();
    child = start(database.url);
    const output = capture(child);

    const listening = await waitForLog(child, output, "listening");
    // The listener binds before migrations run, so that /health can answer throughout —
    // that is what makes a booting instance distinguishable from a broken one. "ready" is
    // logged only once they have applied.
    await waitForLog(child, output, "ready");
    const response = await fetch(`http://127.0.0.1:${listening.port}/health`);

    expect(response.status).toBe(200);
    // Every set, from the *built* artifact: a Plugin resolves its migrations folder
    // relative to its own module, so this is where a package that ships `dist` but forgets
    // to ship `migrations` would be caught. Source-resolved tests never see that.
    //
    // `project` is this Project's own set, and it is the one this assertion most needs to
    // run against the built artifact. It resolves `migrations/` by asking Node where this
    // Project's `package.json` is, precisely because `src/` and `dist/src/` sit at
    // different depths — a path correct in source and wrong in `dist` would apply no
    // migrations at all rather than throwing, and only a test of the built thing sees it.
    //
    // The list comes from `kobai.config.ts`, the one file that decides it, with Core's own
    // set in front exactly as `createKobai` puts it there — so wiring a fourth Plugin is a
    // line in that file and nothing here (#129).
    const wired = [coreMigrationSet, ...(config.migrationSets ?? [])];
    // A config wiring nothing would leave both sides at Core's set alone and agree, so the
    // floor is the price of deriving: this Project wires a Plugin's set beside its own, and
    // which packages ship one at all is asked of the disk in
    // `tests/every-migration-set-is-wired.test.ts`.
    expect(wired.length).toBeGreaterThan(1);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      migrations: { sets: wired.map((set) => ({ name: set.name })) },
    });

    // **What the derived list cannot say**, and the reason it is safe to derive one at all.
    // `/health` is the application repeating the list it was handed, so a set named there is
    // no evidence its migrations reached the container: a package that ships `dist` and no
    // `migrations/` is reported by name, with nothing behind it. This asks the database
    // instead, one migration at a time and matched by the digest Drizzle stores, so the
    // failure names the tag that never applied rather than reporting that two lists differ
    // (ADR-0049).
    //
    // The direction neither half covers — a set quietly dropped from `kobai.config.ts`,
    // which shrinks both sides — is `tests/every-migration-set-is-wired.test.ts`, where the
    // config meets the packages on disk.
    for (const set of wired) {
      const declared = await declaredMigrations(set);
      expect(
        declared.length,
        `${set.name} declares no migrations at all.`,
      ).toBeGreaterThan(0);
      await expect(
        appliedMigrations(database, set),
        `The built artifact reported ${set.name} as applied and the database does not hold every migration it declares. A package that ships \`dist\` without \`migrations/\` looks exactly like this.`,
      ).resolves.toEqual(declared);
    }
  });

  it("seeds the first Merchant from the environment, and can be signed in as", async () => {
    database = await createTestDatabase();
    child = start(database.url, INITIAL_MERCHANT);
    const output = capture(child);

    const listening = await waitForLog(child, output, "listening");
    await waitForLog(child, output, "initial merchant seeded");

    // The whole point of the exercise: those credentials open the Admin. Asked over HTTP,
    // because a Merchant nobody can sign in as is not a Merchant.
    const signedIn = await fetch(`http://127.0.0.1:${listening.port}/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: INITIAL_MERCHANT.KOBAI_INITIAL_MERCHANT_EMAIL,
        password: INITIAL_MERCHANT.KOBAI_INITIAL_MERCHANT_PASSWORD,
      }),
    });

    expect(signedIn.status).toBe(201);
    // It says which account exists, and never what opens it. The password arrived through
    // an environment, so it is already in a compose file; the log is the copy that would
    // fan out to every aggregator this deployment ships to.
    expect(output()).toContain(INITIAL_MERCHANT.KOBAI_INITIAL_MERCHANT_EMAIL);
    expect(output()).not.toContain(INITIAL_MERCHANT.KOBAI_INITIAL_MERCHANT_PASSWORD);
  });

  it("creates no second Merchant when the same deployment boots again", async () => {
    database = await createTestDatabase();
    child = start(database.url, INITIAL_MERCHANT);
    await waitForLog(child, capture(child), "ready");
    child.kill("SIGKILL");

    // The commonest thing that happens to a deployment, and the one that must change
    // nothing: a restart. Same database, same variables.
    child = start(database.url, INITIAL_MERCHANT);
    const output = capture(child);
    await waitForLog(child, output, "ready");

    expect(output()).toContain("initial merchant already present");
    const [row] = await database.query<{ count: string }>(
      "select count(*)::text as count from core_merchant",
    );
    expect(row?.count).toBe("1");
  });

  it("boots without them, keeps serving, and says the deployment has no Merchant", async () => {
    database = await createTestDatabase();
    child = start(database.url);
    const output = capture(child);

    const listening = await waitForLog(child, output, "listening");
    // Not a crash and not a silence. It reaches `ready` — migrations applied, the Store is
    // there — and says separately that nobody can administer it, which is the distinction
    // `/health` draws for migrations and this draws for the Merchant.
    await waitForLog(child, output, "ready");

    expect(output()).toContain("no initial merchant");
    const health = await fetch(`http://127.0.0.1:${listening.port}/health`);
    expect(health.status).toBe(200);
    // …and the admin surface is closed rather than open, which is what makes an
    // unconfigured deployment survivable rather than a free-for-all.
    const admin = await fetch(`http://127.0.0.1:${listening.port}/admin/store`);
    expect(admin.status).toBe(401);
  });

  it("reports a database that is not up yet as booting, not as a failed migration", async () => {
    // The other half of the test below, and the one #80 was about. A Postgres that has not
    // finished starting used to reach `migrate()` and come back as *Core's migration set
    // failed* — a refusal that was right and a reason that was wrong. Nothing is listening
    // on port 1, which is the fastest honest version of "the database is not there yet".
    child = start("postgres://kobai:kobai@127.0.0.1:1/kobai");
    const output = capture(child);

    const listening = await waitForLog(child, output, "listening");
    await waitForLog(child, output, "waiting for the database");

    const health = await fetch(`http://127.0.0.1:${listening.port}/health`);

    // Booting, because that is what it is doing. `error` is reserved for the instance that
    // will never work, and this one still might.
    expect(health.status).toBe(503);
    await expect(health.json()).resolves.toMatchObject({
      status: "booting",
      migrations: { status: "pending" },
    });
    expect(
      output(),
      "The boot blamed a migration for a database it never reached. No migration has run at this point — that is the confusion #80 removed.",
    ).not.toContain("migrations failed");
  });

  it("exits non-zero, and serves nothing, when a migration fails", async () => {
    database = await createTestDatabase();
    // Core's first migration creates `core_store`. Getting there first makes it fail for a
    // reason a real deployment can hit — someone's hand-rolled table, a partial restore —
    // rather than by taking the database away.
    await database.query('create table "core_store" (squatter text)');

    child = start(database.url);
    const output = capture(child);

    const exitCode = await waitForExit(child);

    expect(exitCode).toBe(1);
    expect(output()).toContain("refusing to start");
    // It never declared itself ready, so nothing downstream was ever told to send it work.
    expect(output()).not.toContain('"ready"');
  });
});

/** What a deployment is told its first Merchant is. Distinctive, so a log can be searched. */
const INITIAL_MERCHANT = {
  KOBAI_INITIAL_MERCHANT_EMAIL: "seeded-owner@example.test",
  KOBAI_INITIAL_MERCHANT_PASSWORD: "a seeded owner's very long password",
} as const;

function start(
  databaseUrl: string,
  environment: Readonly<Record<string, string>> = {},
): ChildProcess {
  return spawn(process.execPath, [entrypoint], {
    // PORT=0 lets the kernel pick, so concurrent test files never collide on a port.
    // The seeding variables are *removed* rather than merely not added: a Developer running
    // the suite may well have them set in their own shell, and a test of what an
    // unconfigured deployment does must not inherit a configuration.
    env: {
      ...withoutInitialMerchant(process.env),
      DATABASE_URL: databaseUrl,
      PORT: "0",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function withoutInitialMerchant(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...environment };
  for (const name of Object.keys(INITIAL_MERCHANT)) delete copy[name];
  return copy;
}

function capture(process: ChildProcess): () => string {
  let output = "";
  const append = (chunk: unknown) => {
    output += String(chunk);
  };
  process.stdout?.on("data", append);
  process.stderr?.on("data", append);
  return () => output;
}

type LogLine = { message?: string; port?: number };

async function waitForLog(
  process: ChildProcess,
  output: () => string,
  message: string,
): Promise<LogLine> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const line of output().split("\n")) {
      const parsed = parseLog(line);
      if (parsed?.message === message) return parsed;
    }
    if (process.exitCode !== null) break;
    await sleep(50);
  }
  throw new Error(`The server never logged "${message}". Its output was:\n${output()}`);
}

function parseLog(line: string): LogLine | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    return JSON.parse(line) as LogLine;
  } catch {
    return undefined;
  }
}

function waitForExit(process: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The server did not exit within 20s.")),
      20_000,
    );
    process.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
