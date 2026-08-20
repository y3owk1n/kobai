import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, testPostgresUrl } from "@kobai/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFor, postgresUrl, repoRoot } from "../scripts/env.ts";

/**
 * The credentials a Developer sets, and the ones the suite dials (#63).
 *
 * `compose.yaml` has always honoured `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`
 * from `.env`. The test harness did not: it was handed an address built from `kobai:kobai`,
 * whatever the file said, so changing the password gave a container with the new one and a
 * suite still dialling the old — an authentication failure naming neither `.env` nor the
 * harness.
 *
 * **The rule survives its machinery.** It used to be carried by thirty lines of `awk` in
 * `devbox.json`'s `init_hook`, which is why this file used to run that hook. Under ADR-0084
 * `.env` is read by `process.loadEnvFile` — Node's own, following the same grammar compose
 * does — and the address is assembled in `scripts/env.ts` from the parts, at the moment it
 * is needed. So what is left to test here is the part that is kobai's rather than Node's:
 * that the assembled address signs in, against a real Postgres, with credentials awkward
 * enough to break it.
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
 */

/**
 * The password every case below is built around, and every character in it is deliberate.
 *
 * A simple one proves nothing: `kobai` survives a URL built by pasting strings together,
 * which is what this used to be. This one carries a space, an `=`, a `#`, both kinds of
 * quote, and the three characters — `/`, `?`, `#` — that end the authority of a URL, so an
 * unencoded one would send the suite at another host, another path, or in with no password
 * at all.
 *
 * `$` is deliberately absent. docker compose interpolates variables inside a double-quoted
 * value in `.env`, so a password holding one is a hazard belonging to that file rather than
 * anything here, and `.env.example` says so.
 */
const PASSWORD = `p@ss w0rd="it's #1"; 50%/?!`;

/**
 * What this checkout calls its compose project, its containers and its volume.
 *
 * Compose's own default — the directory's basename — since ADR-0084 dropped the derived
 * name. Two worktrees have different basenames and so stay separate projects; two clones
 * both called `kobai` do not, which is the collision that ADR knowingly declines to cover.
 * A pin still wins, because compose honours one.
 */
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME ?? basename(resolve(repoRoot));

/**
 * `name`, scoped to a compose project — and the only shape anything below ever matches a role
 * on.
 *
 * The suffix is what stops an interrupted run being *contagious* (#282): a role left behind
 * carries the name of the checkout that made it, so no other checkout sharing a Postgres —
 * and no human — has one by that name, and a leaked set is `like 'kobai admin=1 %'` away from
 * being found. It also keeps the reach of `drop owned by` in `clearAway` down to the one role
 * this file creates for this checkout, which is a hazard the ticket names by name.
 *
 * The project is an argument rather than read from above so that the refusal below can be
 * watched from a test rather than only reasoned about.
 */
function scopedTo(project: string, name: string): string {
  const scoped = `${name} ${project}`;
  // Postgres truncates an identifier past 63 bytes rather than refusing it, so an over-long
  // project name would create a role under one name and dial it under another — an
  // authentication failure naming neither. Say so instead. The name is a directory's
  // basename now, so this is reachable by a deep enough worktree as well as by a pin.
  const bytes = new TextEncoder().encode(scoped).length;
  if (bytes > 63) {
    throw new Error(
      `The Postgres login this file creates would be ${bytes} bytes (${scoped}), and Postgres silently truncates an identifier at 63. The compose project name is what makes it this long — it is this directory's basename unless COMPOSE_PROJECT_NAME pins one. Pin a shorter one in \`.env\`.`,
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
 */
const POSTGRES_LOGIN = {
  user: scopedTo(COMPOSE_PROJECT, "kobai admin=1"),
  password: PASSWORD,
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
 * The address `scripts/env.ts` builds for that login, pointed at the Postgres this suite is
 * already running against.
 *
 * The port is taken from the running harness rather than derived: the container is published
 * on the port *this* checkout uses, and only the credentials are the subject here. This is
 * the one call under test — everything else in this file exists to give it a real server to
 * be right or wrong against.
 */
function addressForTheLogin(): string {
  return postgresUrl(Number(new URL(testPostgresUrl()).port), {
    POSTGRES_USER: POSTGRES_LOGIN.user,
    POSTGRES_PASSWORD: POSTGRES_LOGIN.password,
    POSTGRES_DB: POSTGRES_LOGIN.database,
  });
}

/**
 * Runs `work` with the harness pointed at `url`, and puts `KOBAI_TEST_DATABASE_URL` back.
 *
 * `vitest.config.ts` sets that variable for the whole run, so it is set under the gate and
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
  await asSuperuser(clearTheLoginsAway);
});

describe("the credentials the suite dials with", () => {
  it("signs the harness in with them, against a real Postgres", async () => {
    // The whole file in one case: an address assembled from three awkward values, handed to
    // the harness, accepted by a server. Every encoding decision below is either right here
    // or the connection is refused.
    const session = await asHarness(addressForTheLogin(), (database) =>
      database.query<{ user: string; database: string }>(
        "select current_user as user, current_database() as database",
      ),
    );

    expect(session[0]?.user).toBe(POSTGRES_LOGIN.user);
  });

  it("lets an explicit address beat the parts, for a real database or a colleague's", async () => {
    const url = addressForTheLogin();
    await pointingTheHarnessAt(url, async () => {
      expect(testPostgresUrl()).toBe(url);
    });
  });
});

describe("encoding against the driver rather than against the RFC", () => {
  // `pg` decodes the two halves of an address differently, and the difference is not
  // cosmetic: `decodeURI` never unescapes a reserved character, so an over-encoded `=` in a
  // database name arrives as a literal `%3D` and Postgres reports a database nobody named.
  // This is the finding ADR-0046 was written around and ADR-0084 carried forward; it now
  // costs two lines of Node rather than thirty of `awk`, and it is still expensive to
  // rediscover.

  it("round-trips a credential through decodeURIComponent, as pg reads it", () => {
    expect(decodeURIComponent(encodeFor("credential", PASSWORD))).toBe(PASSWORD);
  });

  it("round-trips a database name through decodeURI, as pg reads it", () => {
    expect(decodeURI(encodeFor("path", POSTGRES_LOGIN.database))).toBe(
      POSTGRES_LOGIN.database,
    );
  });

  it("does not over-encode a reserved character in a database name", () => {
    // The failure this prevents, stated as the thing that must not happen: encode `=` the
    // way a credential is encoded and `decodeURI` hands back `%3D`.
    expect(decodeURI(encodeFor("credential", "a=b"))).not.toBe("a=b");
    expect(decodeURI(encodeFor("path", "a=b"))).toBe("a=b");
  });

  it("still escapes what would end the authority of a URL", () => {
    const address = new URL(
      postgresUrl(5432, {
        POSTGRES_USER: "u",
        POSTGRES_PASSWORD: PASSWORD,
        POSTGRES_DB: "d",
      }),
    );

    expect(address.hostname).toBe("127.0.0.1");
    expect(address.pathname).toBe("/d");
    expect(decodeURIComponent(address.password)).toBe(PASSWORD);
  });
});

/**
 * Underneath everything above, `compose.yaml` and the harness each still carry a literal for
 * a checkout that sets nothing — `${POSTGRES_USER:-kobai}` and the fallback URL.
 *
 * `tests/the-fallback-postgres-port.test.ts` holds the two *ports* to being one number and
 * deliberately left these alone, on the grounds that two agreeing credential literals would
 * have fixed nothing while the credentials reached the harness on neither path. Now that they
 * reach it on the same path, the pair is exactly the port's shape — one value written twice,
 * kept in step by whoever remembers — so it gets the port's guardrail.
 *
 * There were three copies while devbox derived a third; there are two now, which is one
 * fewer thing to keep true.
 */
describe("compose and the test harness agree on the fallback credentials", () => {
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
        `${COMPOSE} names \${${variable}} with no \`:-<value>\` default, so a bare \`docker compose\` starts the container with an empty one.`,
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
        `${COMPOSE} falls back to ${defaults.size} different values for ${variable} (${[...defaults].join(", ")}), so what the container starts with could not be read. Expected exactly one.`,
      );
    }
    return only;
  }

  /**
   * What the harness dials with no `KOBAI_TEST_DATABASE_URL` set. The variable is taken away
   * for the length of the call and put back: `vitest.config.ts` sets it for the whole run, so
   * a test about the fallback has to remove it to see one.
   */
  function dialsWithNothingSet(): URL {
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

  it("starts the container with the credentials the harness falls back to", async () => {
    const contents = await readFile(
      fileURLToPath(new URL("../compose.yaml", import.meta.url)),
      "utf8",
    );

    const compose = {
      user: composeDefault(contents, "POSTGRES_USER"),
      password: composeDefault(contents, "POSTGRES_PASSWORD"),
      database: composeDefault(contents, "POSTGRES_DB"),
    };
    const harness = credentialsOf(dialsWithNothingSet());

    const disagreement = [
      "These two are one set of credentials, and they have come apart.",
      `  the container starts with — ${COMPOSE}: ${JSON.stringify(compose)}`,
      `  the suite falls back to — ${HARNESS}: ${JSON.stringify(harness)}`,
      "Change both, or neither. With a `.env` present they both come from it, so nothing else here would have told you.",
    ].join("\n");

    expect(harness, disagreement).toEqual(compose);
  });

  it("assembles the same credentials from the parts, so `.env` and the fallback agree", () => {
    const assembled = credentialsOf(new URL(postgresUrl(5432, {})));

    expect(assembled).toEqual(credentialsOf(dialsWithNothingSet()));
  });
});
