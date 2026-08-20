import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestDatabase, testPostgresUrl } from "@kobai/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkoutPinning,
  checkoutWithNoDotenv,
  discardCheckouts,
  runInitHook,
  thisCheckout,
} from "./support/init-hook.ts";

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
 *
 * **This is the only file in the suite that creates a Postgres *role*** (#282), and a role is
 * the one server-level object here that a later run can trip over. A database is server-level
 * too — `createTestDatabase` makes one per test and an interrupted run leaks it — but that
 * name is random, so it collides with nothing, and `drop database` never refuses. A role's
 * name is written down, it outlives both the database this file made and the run that made
 * it, and its own cleanup is the only thing that removes it. So an interrupted run left one
 * behind that the next attempt could not drop —
 * `role "kobai admin=1" cannot be dropped because some objects depend on it` — and the
 * symptom was not local to this file: it presented as timeouts in a dozen unrelated ones.
 * Three things below answer it, and each answers a different half; `clearAway` says which,
 * and which of them is doing the actual work.
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

/**
 * What this checkout calls its containers, its compose project and its volume — asked of the
 * derivation in `devbox.json`'s `init_hook` rather than restated here (#21).
 *
 * It is `kobai-<the checkout path, hashed>`, and a second, independently-derived hash for the
 * names below would be the very disagreement that derivation exists to prevent.
 *
 * Run rather than read out of `process.env`, because the suite runs under `devbox run test`
 * and outside it alike and only one of those has it exported — but a pin *is* taken from the
 * environment and handed on, because the hook lets one beat its own derivation while
 * `runInitHook` deliberately passes nothing through. Without that, a pinned name would be on
 * the containers while this named something else.
 */
async function deriveComposeProject(): Promise<string> {
  const pinned = process.env.COMPOSE_PROJECT_NAME;
  const { COMPOSE_PROJECT_NAME } = await runInitHook({
    root: thisCheckout(),
    ...(pinned === undefined ? {} : { env: { COMPOSE_PROJECT_NAME: pinned } }),
    report: ["COMPOSE_PROJECT_NAME"],
  });
  return COMPOSE_PROJECT_NAME;
}

const COMPOSE_PROJECT = await deriveComposeProject();

/**
 * `name`, scoped to a compose project — and the only shape anything below ever matches a role
 * on.
 *
 * The suffix is what stops an interrupted run being *contagious* (#282): a role left behind
 * carries the hash of the checkout that made it, so no other checkout sharing a Postgres —
 * and no human — has one by that name, and a leaked set is `like 'kobai admin=1 %'` away from
 * being found. It also keeps the reach of `drop owned by` in `clearTheLoginAway` down to the
 * one role this file creates for this checkout, which is a hazard the ticket names by name.
 *
 * The project is an argument rather than read from above so that the refusal below can be
 * watched from a test rather than only reasoned about.
 */
function scopedTo(project: string, name: string): string {
  const scoped = `${name} ${project}`;
  // Postgres truncates an identifier past 63 bytes rather than refusing it, so an
  // over-long COMPOSE_PROJECT_NAME would create a role under one name and dial it under
  // another — an authentication failure naming neither. Say so instead.
  const bytes = new TextEncoder().encode(scoped).length;
  if (bytes > 63) {
    throw new Error(
      `The Postgres login this file creates would be ${bytes} bytes (${scoped}), and Postgres silently truncates an identifier at 63. COMPOSE_PROJECT_NAME is what makes it this long; derived it is \`kobai-<8 hex>\`, so this is a pin in \`.env\` or the environment.`,
    );
  }
  return scoped;
}

/**
 * The Postgres login the end-to-end cases use, none of it a bare word.
 *
 * `POSTGRES_LOGIN` rather than a role: in kobai a **Role** is the named set of Permissions a
 * Merchant holds (`CONTEXT.md`), and this is a Postgres one — the same care
 * `packages/core/src/testing/database.ts` takes to say "maintenance" rather than "admin".
 *
 * Both names carry this checkout's own, and the space in front of it is one more awkward
 * character in a name that already had to survive quoting.
 */
const POSTGRES_LOGIN = {
  user: scopedTo(COMPOSE_PROJECT, "kobai admin=1"),
  password: PASSWORD,
  dotenvPassword: DOTENV_PASSWORD,
  database: scopedTo(COMPOSE_PROJECT, "kobai db=1"),
} as const;

/**
 * What this file called the same two things before #282, when neither carried a checkout.
 *
 * A Postgres volume older than that change may still be holding that role, stuck for exactly
 * the reason the ticket describes — and nothing else will ever clear it, since no run creates
 * those names any more. Both are exact, and both are this file's own, so this reaches nothing
 * a human made. **Delete it once no volume predates #282.**
 */
const LEGACY_LOGIN = {
  user: "kobai admin=1",
  database: "kobai db=1",
} as const;

/**
 * The address the hook builds for a checkout whose `.env` holds that login, pointed at the
 * Postgres this suite is already running against.
 *
 * The port is passed rather than derived: the container is published on the port *this*
 * checkout derived, and the fabricated checkout would derive its own from its own temporary
 * path. Only the credentials are the subject here.
 */
async function deriveTheLogin(): Promise<string> {
  const root = await checkoutPinning(
    [
      `POSTGRES_USER="${POSTGRES_LOGIN.user}"`,
      `POSTGRES_PASSWORD="${POSTGRES_LOGIN.dotenvPassword}"`,
      `POSTGRES_DB="${POSTGRES_LOGIN.database}"`,
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
 * Runs `work` with the harness pointed at `url`, and puts `KOBAI_TEST_DATABASE_URL` back.
 *
 * devbox exports that variable in front of every script, so it is set under the gate and
 * every other file in this run is using it.
 */
async function pointingTheHarnessAt<T>(url: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.KOBAI_TEST_DATABASE_URL;
  process.env.KOBAI_TEST_DATABASE_URL = url;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.KOBAI_TEST_DATABASE_URL;
    else process.env.KOBAI_TEST_DATABASE_URL = previous;
  }
}

/**
 * Runs `work` against a throwaway database of the harness's own making, signed in as `url`
 * says — the harness itself, not a connection this file opens, because "the suite can sign in
 * with these credentials" is the claim.
 */
async function asHarness<T>(
  url: string,
  work: (database: Awaited<ReturnType<typeof createTestDatabase>>) => Promise<T>,
): Promise<T> {
  return pointingTheHarnessAt(url, async () => {
    const database = await createTestDatabase();
    try {
      return await work(database);
    } finally {
      await database.drop();
    }
  });
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
 * Runs maintenance work as the Developer's own superuser — the credentials this checkout is
 * already running under — through a throwaway database of the harness's own making.
 */
async function asSuperuser<T>(
  work: (database: Awaited<ReturnType<typeof createTestDatabase>>) => Promise<T>,
): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await work(database);
  } finally {
    await database.drop();
  }
}

/**
 * Everything a Postgres login of this file's owns, gone — and **the same call whether the run
 * that made it finished or was killed** (#282). `beforeAll` reconciles with it and `afterAll`
 * cleans up with it, so the repair is on the path every run already takes rather than on one
 * a human has to remember with `psql`.
 *
 * Three statements, in an order that is the whole of the fix:
 *
 * 1. **The databases the login owns, found by owner.** This is the load-bearing one, and it
 *    is the one the ticket's three shapes do not include: `drop owned by` deliberately does
 *    **not** remove a database — a database is not "within the current database" — so the
 *    dependency that refuses `drop role` survives it. Watched: against a role owning one, the
 *    two statements below still answered `cannot be dropped because some objects depend on it
 *    … owner of database`. By **owner** rather than by name because the databases that
 *    actually pin the role down are `createTestDatabase`'s own `kobai_test_<random hex>`
 *    throwaways, made under this login by `asHarness` and named nothing anyone wrote down.
 * 2. **`drop owned by`**, for anything the login owns in the database this is running in and
 *    for its privileges on shared objects. It takes no `if exists`, which is why the role is
 *    asked after first.
 * 3. **`drop role`**, which by then has nothing left depending on it.
 *
 * **The role is matched by its exact name, bound as a parameter, and never by a pattern.**
 * `drop owned by` drops what a role owns, so aiming it at a `like` would be a real hazard —
 * `kobai admin=1 %` would reach another checkout's role on a shared Postgres, and a bare
 * `kobai%` a Developer's own. The two names it is ever handed are this file's own: this
 * checkout's, and the one this file used before #282.
 */
async function clearAway(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  login: { readonly user: string; readonly database: string },
): Promise<void> {
  const [present] = await database.query<{ present: number }>(
    "select 1 as present from pg_roles where rolname = $1",
    [login.user],
  );

  if (present !== undefined) {
    const owned = await database.query<{ name: string }>(
      "select datname as name from pg_database join pg_roles on datdba = pg_roles.oid where rolname = $1",
      [login.user],
    );
    for (const { name } of owned) {
      await database.query(`drop database if exists ${identifier(name)} with (force)`);
    }

    await database.query(`drop owned by ${identifier(login.user)}`);
    await database.query(`drop role ${identifier(login.user)}`);
  }

  // Unconditional, because a database can outlive the role that owned it only if something
  // reassigned it — and this name belongs to this file either way.
  await database.query(
    `drop database if exists ${identifier(login.database)} with (force)`,
  );
}

/** This checkout's login and the one that predates #282, both cleared away. */
async function clearTheLoginsAway(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
): Promise<void> {
  await clearAway(database, POSTGRES_LOGIN);
  await clearAway(database, LEGACY_LOGIN);
}

/**
 * That login, made — and whatever the last run left behind cleared away first, in the same
 * session, because a throwaway database costs more than every statement in it.
 */
async function createTheLogin(): Promise<void> {
  await asSuperuser(async (database) => {
    await clearTheLoginsAway(database);
    // `createdb` because that is what the harness does with a maintenance database: one
    // throwaway per test file. It is also what makes the role hard to drop later, since
    // every database it creates is a dependency on it.
    await database.query(
      `create role ${identifier(POSTGRES_LOGIN.user)} with login createdb password ${literal(POSTGRES_LOGIN.password)}`,
    );
    await database.query(
      `create database ${identifier(POSTGRES_LOGIN.database)} owner ${identifier(POSTGRES_LOGIN.user)}`,
    );
  });
}

beforeAll(async () => {
  await createTheLogin();
});

afterAll(async () => {
  await discardCheckouts();
  await asSuperuser(clearTheLoginsAway);
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
    const dialled = new URL(await deriveTheLogin());

    expect(decodeURIComponent(dialled.username)).toBe(POSTGRES_LOGIN.user);
    expect(decodeURIComponent(dialled.password)).toBe(POSTGRES_LOGIN.password);
    // `decodeURI`, not `decodeURIComponent`, because that is what `pg` reads the database
    // name with — and it never unescapes a reserved character, so the two disagree here.
    expect(decodeURI(dialled.pathname)).toBe(`/${POSTGRES_LOGIN.database}`);
  });

  it("reads an assignment `export` puts in front of, as compose does", async () => {
    // Compose's grammar strips a leading `export`, so a reader that did not would leave the
    // container holding one password and the suite dialling another — this ticket's defect
    // on a line nobody would think to test.
    const root = await checkoutPinning("export POSTGRES_PASSWORD=exported\n");

    const { KOBAI_TEST_DATABASE_URL } = await runInitHook({
      root,
      report: ["KOBAI_TEST_DATABASE_URL"],
    });

    expect(new URL(KOBAI_TEST_DATABASE_URL).password).toBe("exported");
  });

  it("interprets the escapes compose interprets inside double quotes", async () => {
    // `docker compose config` on the same line reports a newline and a tab; this used to
    // report `anb`. Same defect, one escape along.
    const line = String.raw`POSTGRES_PASSWORD="a\nb\tc\\d"`;
    const root = await checkoutPinning(`${line}\n`);

    const { KOBAI_TEST_DATABASE_URL } = await runInitHook({
      root,
      report: ["KOBAI_TEST_DATABASE_URL"],
    });

    expect(decodeURIComponent(new URL(KOBAI_TEST_DATABASE_URL).password)).toBe(
      "a\nb\tc\\d",
    );
  });

  it("signs the harness in with them, against a real Postgres", async () => {
    // The assertion the ticket is actually about, and the one a URL that merely *looks*
    // right cannot satisfy: a login with this password exists, and the harness gets in as it.
    const derived = await deriveTheLogin();

    const session = await asHarness(derived, async (database) =>
      database.query<{ user: string }>("select current_user as user"),
    );

    expect(session[0]?.user).toBe(POSTGRES_LOGIN.user);
  });

  it("refuses the password truncated at its first punctuation mark", async () => {
    // What the old reader did to this password, made visible. Without this the case above
    // would pass just as well against a Postgres that never checked a password at all, and
    // the file would be asserting that a string arrived rather than that it was accepted.
    const truncated = new URL(await deriveTheLogin());
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
      `POSTGRES_USER="${POSTGRES_LOGIN.user}"\nPOSTGRES_PASSWORD="${DOTENV_PASSWORD}"\n`,
    );

    const { KOBAI_TEST_DATABASE_URL, DATABASE_URL } = await runInitHook({
      root,
      report: ["KOBAI_TEST_DATABASE_URL", "DATABASE_URL"],
    });

    expect(DATABASE_URL).toBe(KOBAI_TEST_DATABASE_URL);
  });

  it("leaves a DATABASE_URL `.env` already carries to `.env`", async () => {
    // `node --env-file` applies that line itself and will not overwrite a variable already
    // in the environment, so exporting one over the top would silently beat a Developer's.
    // The question is asked through the same reader as everything else.
    const root = await checkoutPinning(
      "DATABASE_URL=postgres://someone:else@example.test:5432/theirs\n",
    );

    const { DATABASE_URL } = await runInitHook({ root, report: ["DATABASE_URL"] });

    expect(DATABASE_URL).toBe("");
  });

  it("derives an address for a checkout that has no `.env` at all", async () => {
    // The common case, and the one that broke while this was being built: devbox sources the
    // hook under `set -e`, so a reader that reported "no file" as a failure took down every
    // `devbox run …` in the repository with a bare exit status and no message.
    const { KOBAI_TEST_DATABASE_URL } = await runInitHook({
      root: await checkoutWithNoDotenv(),
      report: ["KOBAI_TEST_DATABASE_URL"],
    });

    expect(new URL(KOBAI_TEST_DATABASE_URL).port).not.toBe("");
  });
});

/**
 * The interruption this file used to need a human to recover from (#282).
 *
 * It comes last of the two describes that touch the login, because it takes the login apart
 * and puts it back: everything above has run by the time it starts, and the describe below
 * asks nothing of Postgres at all.
 */
describe("a run that was killed before it could clean up", () => {
  /**
   * A database made under this run's login and deliberately never dropped — what an
   * interrupted run leaves, staged. Its name is the harness's own random one, which is the
   * point: nothing could look for it by name.
   */
  async function abandonADatabase(): Promise<string> {
    return pointingTheHarnessAt(
      await deriveTheLogin(),
      async () => (await createTestDatabase()).name,
    );
  }

  it("gives its Postgres login the name this checkout's containers carry", async () => {
    // Not tidiness: a fixed name is a role every checkout sharing a Postgres competes for,
    // and one an interrupted run leaves in every one of their way. This is the same
    // `COMPOSE_PROJECT_NAME` `docker ps` shows, from the same hash of the same path (#21) —
    // so a leaked role is attributable to a checkout, and a sweep can find them by prefix.
    expect(COMPOSE_PROJECT).not.toBe("");
    expect(POSTGRES_LOGIN.user).toBe(`kobai admin=1 ${COMPOSE_PROJECT}`);
    expect(POSTGRES_LOGIN.database).toBe(`kobai db=1 ${COMPOSE_PROJECT}`);
  });

  // The name above is only this checkout's if the derivation was handed this checkout's path,
  // and the hash is of the *string*: a trailing slash is a different checkout as far as
  // `cksum` is concerned, so every name in this file would follow it while each assertion
  // went on agreeing with itself about the wrong one. That is exactly what the first version
  // of this did, and the leaked role sat untouched under the real name the whole time. So the
  // path is held against the one devbox actually passes, which is the side nothing here
  // derived — and unlike the project name, it is not something anyone pins. Skipped outside
  // devbox, the one place there is no second side to ask.
  it.skipIf(process.env.DEVBOX_PROJECT_ROOT === undefined)(
    "hands the derivation the very path devbox hands it",
    () => {
      expect(thisCheckout()).toBe(process.env.DEVBOX_PROJECT_ROOT);
    },
  );

  it("refuses a name Postgres would silently truncate", () => {
    // Reachable only through a pinned COMPOSE_PROJECT_NAME — a derived one is 14 bytes — and
    // what it prevents is a role created under one name and dialled under another, which
    // arrives as an authentication failure naming neither.
    expect(() => scopedTo(`kobai-${"x".repeat(60)}`, "kobai admin=1")).toThrow(/63/);
    expect(() => scopedTo(COMPOSE_PROJECT, "kobai admin=1")).not.toThrow();
  });

  it("is repaired by the next attempt rather than by a human with psql", async () => {
    const abandoned = await abandonADatabase();

    // The refusal the ticket is named for, watched rather than described — otherwise the
    // repair below would prove nothing, since a role nothing depends on drops cleanly and
    // the assertions would read identically.
    await expect(
      asSuperuser((database) =>
        database.query(`drop role ${identifier(POSTGRES_LOGIN.user)}`),
      ),
    ).rejects.toThrow(/cannot be dropped because some objects depend on it/);

    // Exactly what `beforeAll` does, and the only thing the next run does differently from
    // the one that was killed.
    await createTheLogin();

    await expect(
      asSuperuser((database) =>
        database.query("select datname from pg_database where datname = $1", [abandoned]),
      ),
    ).resolves.toEqual([]);
    const session = await asHarness(await deriveTheLogin(), (database) =>
      database.query<{ user: string }>("select current_user as user"),
    );
    expect(session[0]?.user).toBe(POSTGRES_LOGIN.user);
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
describe("compose, devbox and the test harness agree on the fallback credentials", () => {
  const COMPOSE = "compose.yaml";
  const HARNESS = "packages/core/src/testing/database.ts";

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

  /** The three credentials an address carries, read the way `pg` reads them. */
  function credentialsOf(url: URL) {
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURI(url.pathname.slice(1)),
    };
  }

  it("starts the container with the credentials the harness dials, and devbox with both", async () => {
    const contents = await readFile(
      fileURLToPath(new URL("../compose.yaml", import.meta.url)),
      "utf8",
    );

    // All three copies, in one assertion, so none of them can be changed in company with
    // one other and left agreeing. devbox's own is reached by running the hook against a
    // checkout with nothing set at all — the only way its `:-kobai` defaults are visible.
    const compose = {
      user: composeDefault(contents, "POSTGRES_USER"),
      password: composeDefault(contents, "POSTGRES_PASSWORD"),
      database: composeDefault(contents, "POSTGRES_DB"),
    };
    const harness = credentialsOf(dialsWithoutDevbox());
    const { KOBAI_TEST_DATABASE_URL } = await runInitHook({
      root: await checkoutWithNoDotenv(),
      report: ["KOBAI_TEST_DATABASE_URL"],
    });
    const devbox = credentialsOf(new URL(KOBAI_TEST_DATABASE_URL));

    const disagreement = [
      "These three are one set of credentials, and they have come apart.",
      `  the container starts with — ${COMPOSE}: ${JSON.stringify(compose)}`,
      `  devbox derives — devbox.json init_hook: ${JSON.stringify(devbox)}`,
      `  the suite falls back to — ${HARNESS}: ${JSON.stringify(harness)}`,
      "Change all three, or none. With a `.env` present they all come from it, so nothing else here would have told you.",
    ].join("\n");

    expect(harness, disagreement).toEqual(compose);
    expect(devbox, disagreement).toEqual(compose);
  });
});
