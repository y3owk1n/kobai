import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, testPostgresUrl } from "@kobai/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInitHook } from "./support/init-hook.ts";

/**
 * The credentials a Developer sets, and the ones the suite dials (#63).
 *
 * `compose.yaml` has always honoured `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`
 * from `.env`. The test harness did not: it was handed an address built from `kobai:kobai`,
 * whatever the file said, so changing the password gave a container with the new one and a
 * suite still dialling the old — an authentication failure naming neither `.env` nor the
 * harness. `devbox.json`'s `init_hook` now reads all three the way it already read the port,
 * and percent-encodes them into both addresses it exports.
 *
 * The other half of #21's rule, in other words: one source decides where the container comes
 * up *and* who it lets in. The failure it prevents is the same one, and so is the reason it
 * has to be tested by running the hook — the gate runs with `KOBAI_TEST_DATABASE_URL`
 * already exported, so nothing else here can see what built it.
 */

/**
 * The password every case below is built around, and every character in it is deliberate.
 *
 * A simple one proves nothing: `kobai` survives a reader that stops at the first punctuation
 * mark and a URL built by pasting strings together, which is what both of these used to be.
 * This one carries a space, an `=`, a `#`, both kinds of quote, and the three characters —
 * `/`, `?`, `#` — that end the authority of a URL, so an unencoded one would send the suite
 * at another host, another path, or in with no password at all.
 *
 * `$` is deliberately absent. docker compose interpolates variables inside a double-quoted
 * value in `.env`, so a password holding one is a hazard belonging to that file rather than
 * anything here, and `.env.example` says so.
 */
const PASSWORD = `p@ss w0rd="it's #1"; 50%/?!`;

/** The same password as a `.env` line writes it: double-quoted, with the inner `"` escaped. */
const DOTENV_PASSWORD = String.raw`p@ss w0rd=\"it's #1\"; 50%/?!`;

/** A whole set of credentials, none of which is a bare word either. */
const ROLE = {
  user: "kobai admin=1",
  password: PASSWORD,
  dotenvPassword: DOTENV_PASSWORD,
  database: "kobai db=1",
} as const;

type Credentials = typeof ROLE;

let workspace: string;

async function checkoutPinning(dotenv: string): Promise<string> {
  const root = await mkdtemp(join(workspace, "checkout-"));
  await writeFile(join(root, ".env"), dotenv);
  return root;
}

/**
 * The address the hook builds for a checkout whose `.env` holds these credentials, pointed
 * at the Postgres this suite is already running against.
 *
 * The port is passed rather than derived: the container is published on the port *this*
 * checkout derived, and the fabricated checkout below would derive its own from its own
 * temporary path. Only the credentials are the subject here.
 */
async function deriveAgainst(credentials: Credentials): Promise<string> {
  const root = await checkoutPinning(
    [
      `POSTGRES_USER="${credentials.user}"`,
      `POSTGRES_PASSWORD="${credentials.dotenvPassword}"`,
      `POSTGRES_DB="${credentials.database}"`,
      "",
    ].join("\n"),
  );

  const { KOBAI_TEST_DATABASE_URL } = await runInitHook({
    root,
    env: { POSTGRES_PORT: new URL(testPostgresUrl()).port },
    report: ["KOBAI_TEST_DATABASE_URL"],
  });
  return KOBAI_TEST_DATABASE_URL;
}

/**
 * Runs `work` with the harness pointed at `url` — the harness itself, not a connection this
 * file opens, because "the suite can sign in with these credentials" is the claim.
 *
 * `KOBAI_TEST_DATABASE_URL` is put back afterwards. devbox exports it in front of every
 * script, so it is set under the gate and every other file in this run is using it.
 */
async function asHarness<T>(
  url: string,
  work: (database: Awaited<ReturnType<typeof createTestDatabase>>) => Promise<T>,
): Promise<T> {
  const previous = process.env.KOBAI_TEST_DATABASE_URL;
  process.env.KOBAI_TEST_DATABASE_URL = url;
  try {
    const database = await createTestDatabase();
    try {
      return await work(database);
    } finally {
      await database.drop();
    }
  } finally {
    if (previous === undefined) delete process.env.KOBAI_TEST_DATABASE_URL;
    else process.env.KOBAI_TEST_DATABASE_URL = previous;
  }
}

/** `"` doubled, the way Postgres quotes an identifier holding a space or an `=`. */
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** `'` doubled, the way Postgres quotes a literal — and this password holds one. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Runs maintenance SQL as the Developer's own superuser — the credentials this checkout is
 * already running under — through a throwaway database of the harness's own making.
 */
async function asSuperuser(statements: readonly string[]): Promise<void> {
  const database = await createTestDatabase();
  try {
    for (const statement of statements) await database.query(statement);
  } finally {
    await database.drop();
  }
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "kobai-credentials-"));

  // The role the end-to-end cases sign in as. `createdb` because that is what the harness
  // does with a maintenance database: one throwaway per test file.
  await asSuperuser([
    `drop database if exists ${identifier(ROLE.database)} with (force)`,
    `drop role if exists ${identifier(ROLE.user)}`,
    `create role ${identifier(ROLE.user)} with login createdb password ${literal(ROLE.password)}`,
    `create database ${identifier(ROLE.database)} owner ${identifier(ROLE.user)}`,
  ]);
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  await asSuperuser([
    `drop database if exists ${identifier(ROLE.database)} with (force)`,
    `drop role if exists ${identifier(ROLE.user)}`,
  ]);
});

describe("the credentials the test harness dials with", () => {
  it("takes the password from `.env`, where a Developer is told to put it", async () => {
    const root = await checkoutPinning("POSTGRES_PASSWORD=s3cret\n");

    const { KOBAI_TEST_DATABASE_URL } = await runInitHook({
      root,
      report: ["KOBAI_TEST_DATABASE_URL"],
    });

    expect(new URL(KOBAI_TEST_DATABASE_URL).password).toBe("s3cret");
  });

  it("carries a password a Developer might actually choose", async () => {
    const dialled = new URL(await deriveAgainst(ROLE));

    expect(decodeURIComponent(dialled.username)).toBe(ROLE.user);
    expect(decodeURIComponent(dialled.password)).toBe(ROLE.password);
    expect(decodeURIComponent(dialled.pathname)).toBe(`/${ROLE.database}`);
  });

  it("signs the harness in with them, against a real Postgres", async () => {
    // The assertion the ticket is actually about, and the one a URL that merely *looks*
    // right cannot satisfy: a role with this password exists, and the harness gets in as it.
    const derived = await deriveAgainst(ROLE);

    const session = await asHarness(derived, async (database) =>
      database.query<{ user: string }>("select current_user as user"),
    );

    expect(session[0]?.user).toBe(ROLE.user);
  });

  it("refuses the password truncated at its first punctuation mark", async () => {
    // What the old reader did to this password, made visible. Without this the case above
    // would pass just as well against a Postgres that never checked a password at all, and
    // the file would be asserting that a string arrived rather than that it was accepted.
    const truncated = new URL(await deriveAgainst(ROLE));
    truncated.password = encodeURIComponent("p");

    await expect(asHarness(truncated.toString(), async () => undefined)).rejects.toThrow(
      /Could not reach Postgres/,
    );
  });

  it("lets the environment beat `.env`, as it does for the ports", async () => {
    const root = await checkoutPinning(`POSTGRES_PASSWORD="${DOTENV_PASSWORD}"\n`);

    const { KOBAI_TEST_DATABASE_URL } = await runInitHook({
      root,
      env: { POSTGRES_PASSWORD: "from-the-environment" },
      report: ["KOBAI_TEST_DATABASE_URL"],
    });

    expect(new URL(KOBAI_TEST_DATABASE_URL).password).toBe("from-the-environment");
  });

  it("leaves an address someone set by hand alone", async () => {
    // The escape hatch, and the only way to reach a Postgres these three cannot describe.
    const root = await checkoutPinning(`POSTGRES_PASSWORD="${DOTENV_PASSWORD}"\n`);
    const pinned = "postgres://someone:else@example.test:5432/theirs";

    const { KOBAI_TEST_DATABASE_URL } = await runInitHook({
      root,
      env: { KOBAI_TEST_DATABASE_URL: pinned },
      report: ["KOBAI_TEST_DATABASE_URL"],
    });

    expect(KOBAI_TEST_DATABASE_URL).toBe(pinned);
  });

  it("gives `devbox run dev` the same credentials it gives the suite", async () => {
    // The third address of #21's five, and the one a Developer's application connects with.
    // Two addresses onto one database that disagreed about the password would be this
    // ticket's failure again, one variable along.
    const root = await checkoutPinning(
      `POSTGRES_USER="${ROLE.user}"\nPOSTGRES_PASSWORD="${DOTENV_PASSWORD}"\n`,
    );

    const { KOBAI_TEST_DATABASE_URL, DATABASE_URL } = await runInitHook({
      root,
      report: ["KOBAI_TEST_DATABASE_URL", "DATABASE_URL"],
    });

    expect(DATABASE_URL).toBe(KOBAI_TEST_DATABASE_URL);
  });

  it("derives an address for a checkout that has no `.env` at all", async () => {
    // The common case, and the one that broke while this was being built: devbox sources the
    // hook under `set -e`, so a reader that reported "no file" as a failure took down every
    // `devbox run …` in the repository with a bare exit status and no message.
    const { KOBAI_TEST_DATABASE_URL } = await runInitHook({
      root: join(workspace, "no-such-checkout"),
      report: ["KOBAI_TEST_DATABASE_URL"],
    });

    expect(new URL(KOBAI_TEST_DATABASE_URL).password).toBe("kobai");
  });
});

/**
 * Underneath the derived path, `compose.yaml` and the harness each still carry a literal for
 * a bare `docker compose` outside devbox — `${POSTGRES_USER:-kobai}` and the fallback URL.
 *
 * `tests/the-fallback-postgres-port.test.ts` holds the two *ports* to being one number and
 * deliberately left these alone, on the grounds that two agreeing credential literals would
 * have fixed nothing while the credentials reached the harness on neither path. Now that they
 * reach it on the derived one, the pair is exactly the port's shape — one value written
 * twice, kept in step by whoever remembers — so it gets the port's guardrail.
 *
 * The harness side is asked of the harness rather than read out of its source: that file
 * already pins the value against the literal written in it, and a second reader here would
 * be a second thing to keep true.
 */
describe("compose and the test harness agree on the fallback credentials", () => {
  const COMPOSE = "compose.yaml";

  /**
   * What `compose.yaml` falls back to for one variable, across every mention of it.
   *
   * The file names each of these three more than once — the `db` service's environment, its
   * healthcheck, and the app's `DATABASE_URL` — and they have to agree with each other
   * before there is anything for the harness to agree with. Finding no default, or more than
   * one, throws: this must not pass by comparing nothing.
   */
  function composeDefault(contents: string, variable: string): string {
    if (new RegExp(String.raw`\$\{${variable}\}`).test(contents)) {
      throw new Error(
        `${COMPOSE} names \${${variable}} with no \`:-<value>\` default, so a bare \`docker compose\` outside devbox starts the container with an empty one.`,
      );
    }

    const defaults = new Set(
      [
        ...contents.matchAll(new RegExp(String.raw`\$\{${variable}:-([^}]*)\}`, "g")),
      ].flatMap(([, value]) => (value === undefined ? [] : [value])),
    );

    const [only] = [...defaults];
    if (defaults.size !== 1 || only === undefined) {
      throw new Error(
        `${COMPOSE} falls back to ${defaults.size} different values for ${variable} (${[...defaults].join(", ")}), so what the container starts with outside devbox could not be read. Expected exactly one.`,
      );
    }
    return only;
  }

  /**
   * What the harness dials with no `KOBAI_TEST_DATABASE_URL` set. The variable is taken away
   * for the length of the call and put back: devbox exports it in front of every script, so a
   * test about the fallback has to remove it to see one.
   */
  function dialsWithoutDevbox(): URL {
    const previous = process.env.KOBAI_TEST_DATABASE_URL;
    delete process.env.KOBAI_TEST_DATABASE_URL;
    try {
      return new URL(testPostgresUrl());
    } finally {
      if (previous === undefined) delete process.env.KOBAI_TEST_DATABASE_URL;
      else process.env.KOBAI_TEST_DATABASE_URL = previous;
    }
  }

  it("dials the user, password and database the container is started with", async () => {
    const contents = await readFile(
      fileURLToPath(new URL("../compose.yaml", import.meta.url)),
      "utf8",
    );
    const dialled = dialsWithoutDevbox();

    const disagreement = (what: string) =>
      [
        `Outside devbox these two are one value, and they have come apart on the ${what}.`,
        `  the container starts with — ${COMPOSE}`,
        `  the suite signs in with — ${dialled.toString()}`,
        "Change both, or neither. Inside devbox both come from `.env` through devbox.json's init_hook, so nothing else here would have told you.",
      ].join("\n");

    expect(decodeURIComponent(dialled.username), disagreement("user")).toBe(
      composeDefault(contents, "POSTGRES_USER"),
    );
    expect(decodeURIComponent(dialled.password), disagreement("password")).toBe(
      composeDefault(contents, "POSTGRES_PASSWORD"),
    );
    expect(decodeURI(dialled.pathname.slice(1)), disagreement("database")).toBe(
      composeDefault(contents, "POSTGRES_DB"),
    );
  });
});
