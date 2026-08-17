import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestDatabase,
  inspectSchema,
  type TestDatabase,
} from "@kobai/core/testing";
import { scaffold } from "create-kobai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type LocalRegistry,
  publishPackages,
  startLocalRegistry,
} from "./support/local-registry.ts";
import { bootProject, runInProject } from "./support/project.ts";

/**
 * **The release gate.** The only test of the promise the whole project rests on: that a
 * Developer who has customised kobai deeply can take a new major of Core without a merge.
 *
 * ADR-0024 records kobai's one open risk — the architecture ships without production
 * validation, because there is no first store shaking it out as a side effect of being
 * open. ADR-0029 makes this the deliberate substitute. It is worth only as much as it is
 * honest, so what it does and does not prove is written down rather than implied:
 *
 * **What it proves.** A Project that has replaced a Step of Core's price-resolution
 * Workflow, wired a Plugin's migration set, wired a Step that Plugin offers, and owns tables
 * of its own is moved across a Core major by the command kobai ships — and afterwards it
 * builds, boots, applies every migration set, serves a request against a real Postgres, the
 * replaced Step still decides the price, and the Plugin's tables, rows and migration
 * tracking are exactly as they were. Every step is the one a Developer performs.
 *
 * **What it does not prove.** That a codemod transforms anything. `1.0.0` here is `0.1.0`'s
 * code under another number, so there is no breaking change to migrate and the set the new
 * version ships is empty — deliberately, and the command says so out loud rather than
 * succeeding in silence. The mechanism that finds and orders codemods is pinned in
 * `packages/core/src/upgrade/codemods.test.ts`, against fixtures, because inventing a
 * breaking change here would be inventing the thing under test. See ADR-0035.
 *
 * **Why the reference Project rather than a fresh one.** An empty scaffold upgrades cleanly
 * no matter how badly the extension surface has been broken. What `create-kobai` generates
 * *is* the reference Project (ADR-0034), which is why this gate can use the scaffolder and
 * still be testing the Project kobai's maintainers actually run.
 */

/**
 * What this commit's packages are at, read rather than written down.
 *
 * A literal here would be a second copy of a version this repository already pins once, and
 * the copy would go stale silently — the same failure `create-kobai`'s `contextFrom` exists
 * to prevent. Bump the packages and this gate follows them.
 */
async function publishedVersion(): Promise<string> {
  const { version } = JSON.parse(
    await readFile(new URL("../packages/core/package.json", import.meta.url), "utf8"),
  ) as { version?: string };

  if (version === undefined || version === "0.0.0") {
    throw new Error(
      `@kobai/core's version is ${JSON.stringify(version ?? null)}, so there is nothing for this gate to upgrade from. See ADR-0034.`,
    );
  }
  return version;
}

/**
 * The next major above a version, by the rule kobai's own upgrade command uses.
 *
 * Below `1.0.0` the minor *is* the major — `^0.1.0` means `>=0.1.0 <0.2.0` — but the gate
 * jumps straight to `1.0.0` from anywhere in `0.x`, because a first major is the boundary the
 * promise is actually about, and the rule stays right once kobai is past it.
 */
function nextMajor(version: string): string {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return major === 0 ? "1.0.0" : `${major + 1}.0.0`;
}

/** Filled in before anything else, so every message can name the two versions. */
let THIS_VERSION: string;
let SYNTHETIC_MAJOR: string;

/** Two installs, two builds, two boots and a dozen requests, on a cold runner. */
const GATE_TIMEOUT = 1_800_000;

/** Every kobai package a generated Project resolves from a registry. */
const PUBLISHED = ["packages/core", "packages/client", "packages/plugin-price-log"];

let registry: LocalRegistry;
let workspace: string;
let project: string;
let database: TestDatabase;

/** What the Project held and served before anything was upgraded. */
let before: Snapshot;
/** Everything the shipped upgrade command printed. */
let upgradeOutput: string;
/** What it held and served afterwards, against the same database. */
let after: Snapshot;

beforeAll(async () => {
  THIS_VERSION = await publishedVersion();
  SYNTHETIC_MAJOR = nextMajor(THIS_VERSION);

  registry = await startLocalRegistry();

  // The same packages, twice: once as this commit built them, and once as a major that does
  // not exist. See `PublishOptions.version` for why the second is a fair thing to make.
  await publishPackages(registry, PUBLISHED);
  await publishPackages(registry, PUBLISHED, { version: SYNTHETIC_MAJOR });

  workspace = await mkdtemp(join(tmpdir(), "kobai-upgrade-gate-"));
  project = join(workspace, "my-store");
  await scaffold({ directory: project });

  // The one line a Developer would not write: point the `@kobai` scope at the registry
  // holding this commit's packages. Everything else resolves wherever npm normally looks.
  await writeFile(
    join(project, ".npmrc"),
    `@kobai:registry=${registry.url}\n//${registry.url.replace(/^https?:\/\//, "")}/:_authToken=kobai-local\n`,
  );

  await phase("installing the generated Project", () =>
    runInProject(project, "pnpm", ["install"]),
  );
  await phase("building it for the first time", () =>
    runInProject(project, "pnpm", ["-r", "--include-workspace-root", "build"]),
  );

  // One database for both halves. It is the whole point: "the Plugin's tables survive the
  // upgrade" means the rows that were there are still there, which a fresh database would
  // make vacuously true.
  database = await createTestDatabase();

  before = await phase("arranging a Store through the public API", () =>
    serve(project, database.url, arrange),
  );

  // **The upgrade, exactly as a Developer runs it.** `pnpm exec` finds the bin `@kobai/core`
  // declares, so the command is the one this Project has installed — not a script this test
  // wrote, and not a hand-edited manifest.
  //
  // **`CI` is set here on purpose, and it makes this gate stricter rather than kinder.**
  // pnpm defaults `frozen-lockfile` to true whenever `CI` is set, and an upgrade has just
  // made the lockfile out of date deliberately — so this is the one environment in which
  // the command's own install can refuse to run, and it did: green on every Developer's
  // machine and red in GitHub Actions with `ERR_PNPM_OUTDATED_LOCKFILE`. A Developer runs
  // `kobai-upgrade` in their CI too, which is where an upgrade failing costs the most, so
  // the fix belongs in the command and the environment that catches it belongs here.
  upgradeOutput = await phase("running the shipped upgrade command", () =>
    runInProject(project, "pnpm", ["exec", "kobai-upgrade", "--to", SYNTHETIC_MAJOR], {
      CI: "true",
    }),
  );

  // The Developer's next command. `kobai-upgrade` installs and migrates source; building is
  // still theirs to do, and a Project that no longer compiles against the new major fails
  // here rather than at a boot that says something less useful.
  await phase("rebuilding against the new major", () =>
    runInProject(project, "pnpm", ["-r", "--include-workspace-root", "build"]),
  );

  after = await phase("booting the upgraded Project and asking it again", () =>
    serve(project, database.url, async () => before.store),
  );
}, GATE_TIMEOUT);

/**
 * One step of the sequence, named.
 *
 * Criterion 9 is that a failure says which part of the promise broke, and the assertions
 * below do that by being named after their clause. Everything *before* them happens in one
 * hook, so without this a failure to install, build, upgrade or boot would collapse six
 * named diagnoses into one anonymous hook error. This is what keeps the sequence legible up
 * to the point the assertions take over.
 */
async function phase<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    throw new Error(
      `The upgrade gate failed while ${what}.\n\n${(cause as Error).message}`,
      {
        cause,
      },
    );
  }
}

afterAll(async () => {
  await database?.drop();
  await registry?.close();
  await rm(workspace, { recursive: true, force: true });
});

/**
 * Each of these is one clause of ADR-0001's promise, named so that a red test *is* the
 * diagnosis. At three in the morning the useful thing is not `exit 1`, it is a line saying
 * the Step override stopped taking effect.
 */
describe("a customised Project taken across a Core major", () => {
  it("runs the codemods kobai ships, and says which it found", () => {
    // Criterion 4. The command is `@kobai/core`'s own bin, run through `pnpm exec`.
    expect(
      upgradeOutput,
      `The shipped upgrade command did not report on the codemod set at all. It printed:\n${upgradeOutput}`,
    ).toContain(`@kobai/core ${THIS_VERSION} → ${SYNTHETIC_MAJOR}`);

    // **The set came from the version arrived at, not from the one that ran the command.**
    // This is the assertion that catches the failure the design exists to avoid, and it
    // caught it once already: Node's resolver caches by specifier, so the first version of
    // this command re-resolved `@kobai/core` after the install and got the package from
    // before it. At an empty boundary both sets are empty, so nothing else here would have
    // noticed — and the day a real codemod ships, the old version's would have run.
    expect(
      upgradeOutput,
      `The codemod set was read from a version other than ${SYNTHETIC_MAJOR}, so the codemods that would run belong to the version being upgraded *from*. See the note on Node's resolver cache in packages/core/src/upgrade/upgrade.ts.`,
    ).toContain(`@kobai/core@${SYNTHETIC_MAJOR} ships no codemods`);

    expect(
      upgradeOutput,
      "The command did not say what it found in the codemod set. `nothing to do` and `did nothing` are different answers and a Developer has to be able to tell them apart — see docs/adr/0035.",
    ).toContain("not the same as nothing attempted");

    // The distinction that matters most: a version shipping no *set* is a different failure
    // from one shipping an empty set, and this boundary is the second.
    expect(
      upgradeOutput,
      "The version upgraded to shipped no codemod set, so nothing can be said about whether it had codemods. `@kobai/core` must export `./codemods`.",
    ).not.toContain("ships no codemod set");
  });

  it("moves every kobai dependency to the new major, and installs it", async () => {
    // Criterion 3, read out of what the command wrote and what the install put on disk.
    const manifest = JSON.parse(
      await readFile(join(project, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };

    expect(manifest.dependencies["@kobai/core"]).toBe(`^${SYNTHETIC_MAJOR}`);
    expect(manifest.dependencies["@kobai/plugin-price-log"]).toBe(`^${SYNTHETIC_MAJOR}`);

    const installed = JSON.parse(
      await readFile(join(project, "node_modules/@kobai/core/package.json"), "utf8"),
    ) as { version: string };
    expect(
      installed.version,
      "The Project's manifest says the new major but its node_modules holds the old one, so nothing below this tested the upgrade.",
    ).toBe(SYNTHETIC_MAJOR);

    // **The lockfile is part of what an upgrade moves.** It has to be — the ranges above
    // changed, so the resolution it recorded is stale by construction — and the install
    // that follows a range bump is the one install in kobai allowed to rewrite it. A
    // lockfile still pinned to the old major means the command bumped manifests and left
    // the Project's resolution behind, which is the half-upgrade a frozen install produces
    // when it is given its way.
    const lockfile = await readFile(join(project, "pnpm-lock.yaml"), "utf8");
    expect(
      lockfile,
      "The Project's manifests moved to the new major and pnpm-lock.yaml did not, so the upgrade left the lockfile disagreeing with the manifests it just rewrote.",
    ).toContain(`^${SYNTHETIC_MAJOR}`);

    // Criterion 9: the command changed a file the Developer did not name, so it says so.
    // Finding a lockfile in the diff and having to work out who wrote it is exactly the
    // surprise the report exists to prevent.
    expect(
      upgradeOutput,
      `The command rewrote pnpm-lock.yaml and never mentioned it, so a Developer reviewing the diff meets a lockfile change nothing accounted for. It printed:\n${upgradeOutput}`,
    ).toContain("pnpm-lock.yaml");
  });

  it("still boots, and applies every migration set into the database it already had", () => {
    // Criterion 5. Migrations are the part most likely to break across a major, and the
    // database here is the one the pre-upgrade Project wrote to.
    expect(
      after.health,
      `The upgraded Project did not report healthy. Its output:\n${after.logs}`,
    ).toMatchObject({ status: "ok" });

    expect(
      after.health.migrations.sets.map((set) => set.name),
      "A migration set went missing across the upgrade. Core's, the Plugin's and the Project's own are all applied by the same runner, so a set that vanished is a set the new version stopped wiring.",
    ).toEqual(["core", "plugin-price-log", "project"]);
  });

  it("still serves the price the Project's own Step decided, not Core's", () => {
    // **The flagship.** A Merchant priced this Variant at $12.50 and the Project's Step says
    // one cent. If Core's rule wins here, replacing a Step stopped working across the major
    // and ADR-0003's central promise is broken — which is the single thing this gate exists
    // to catch.
    expect(
      after.price.price,
      `The Step override stopped taking effect across the upgrade: the storefront was served ${after.price.price.amount} rather than the 1 this Project's \`everything-costs-one-cent\` Step decides. Core's own \`select-price\` would answer ${PRICED_AT}. See reference/kobai.config.ts and ADR-0003.`,
    ).toMatchObject({ amount: 1, currency: "USD" });

    expect(
      after.price.workflow.steps.map((step) => step.implementation),
      "The Workflow no longer reports this Project's Step in Core's slot. Either the override stopped being applied or the Workflow's shape changed under it.",
    ).toEqual(["load-prices", "everything-costs-one-cent", "record-price-resolution"]);
  });

  it("keeps the Plugin's tables, its rows and its migration tracking intact", async () => {
    // Criterion 7. Three separate ways a Plugin can be broken by an upgrade, and the rows
    // are the one a schema check alone would miss.
    expect(
      after.priceLog.length,
      `The Plugin's table lost rows across the upgrade: ${before.priceLog.length} before, ${after.priceLog.length} after. A Plugin owns its tables (ADR-0004) and an upgrade may not touch them.`,
    ).toBeGreaterThanOrEqual(before.priceLog.length);
    expect(after.priceLog.slice(0, before.priceLog.length)).toEqual(before.priceLog);

    // ...and the Step the Plugin offers still ran, so the table is live rather than merely
    // surviving.
    expect(
      after.priceLog.length,
      "The Plugin's offered Step stopped recording after the upgrade, so its table survived and its wiring did not.",
    ).toBeGreaterThan(before.priceLog.length);

    const tracking = await inspectSchema(database).migrationTracking();
    expect(
      tracking.map((fact) => fact.table).sort(),
      "A migration set's tracking table went missing, so the runner can no longer tell what it has applied. Core, the Plugin and the Project each track their own (ADR-0030).",
    ).toEqual([
      "__drizzle_migrations_core",
      "__drizzle_migrations_plugin_price_log",
      "__drizzle_migrations_project",
    ]);

    expect(
      tracking.filter((fact) => fact.applied === 0),
      "A migration set is tracked and has applied nothing, which is what an upgrade that dropped a package's migrations looks like from the outside.",
    ).toEqual([]);

    // The Plugin's own table, still owned by the Plugin's prefix.
    await expect(
      inspectSchema(database).tablesOwnedBy("price_log"),
      "The Plugin's table did not survive the upgrade. A Plugin owns its tables and Core may not reach into them (ADR-0004).",
    ).resolves.toEqual(["price_log_entry"]);
  });

  it("keeps the Project's own tables, which are the ones it owns outright", async () => {
    await expect(
      inspectSchema(database).tablesOwnedBy("project"),
      "The Project's own tables did not survive the upgrade. A Project owns its repository and its schema; Core may not reach into either (ADR-0004, ADR-0001).",
    ).resolves.toEqual(["project_variant_note"]);
  });
});

type PriceBody = {
  readonly variant: { readonly sku: string };
  readonly price: { readonly amount: number; readonly currency: string };
  readonly workflow: {
    readonly name: string;
    readonly steps: readonly { step: string; implementation: string }[];
  };
};

type PriceLogRow = { variant_id: string; amount: number; currency: string };

type StoreKeys = {
  /** The Variant a storefront asks the price of. */
  readonly variantId: string;
  /** A secret API key's headers, for the store surface. */
  readonly headers: Record<string, string>;
};

type Snapshot = {
  readonly store: StoreKeys;
  readonly health: {
    readonly status: string;
    readonly migrations: { readonly sets: readonly { name: string }[] };
  };
  readonly price: PriceBody;
  readonly priceLog: readonly PriceLogRow[];
  readonly logs: string;
};

/**
 * Boots the Project, asks it the same three questions, and stops it.
 *
 * `reach` is what differs between the two halves: the first arranges a Store and hands back
 * the keys to it, the second hands the same keys straight back. Everything after that —
 * health, the resolved price, the Plugin's rows — is asked identically, which is what makes
 * the two snapshots comparable at all.
 */
async function serve(
  directory: string,
  databaseUrl: string,
  reach: (origin: string) => Promise<StoreKeys>,
): Promise<Snapshot> {
  await using booted = await bootProject(directory, databaseUrl);

  const health = (await (await fetch(`${booted.origin}/health`)).json()) as {
    status: string;
    migrations: { sets: { name: string }[] };
  };
  const store = await reach(booted.origin);

  return {
    store,
    health,
    price: await resolvedPrice(booted.origin, store),
    // Read in the order the Plugin wrote them, so the two snapshots compare row for row.
    priceLog: await database.query<PriceLogRow>(
      "select variant_id, amount, currency from price_log_entry order by resolved_at, id",
    ),
    logs: booted.logs(),
  };
}

/** What a Merchant sets, and what the Project's Step overrides it to. */
const PRICED_AT = 1250;

/**
 * A Store with one priced Variant, arranged through the public API.
 *
 * Through the API rather than by writing rows, because that is all a storefront or a Merchant
 * can do — and because the arrangement itself is part of what has to keep working across the
 * upgrade.
 */
async function arrange(origin: string): Promise<StoreKeys> {
  const credentials = {
    email: "merchant@example.test",
    password: "a merchant's very long password",
  };
  const json = { "content-type": "application/json" };

  await expectStatus(
    await fetch(`${origin}/admin/merchants`, {
      method: "POST",
      headers: json,
      body: JSON.stringify(credentials),
    }),
    201,
    "creating the first Merchant",
  );

  const signedIn = await fetch(`${origin}/admin/session`, {
    method: "POST",
    headers: json,
    body: JSON.stringify(credentials),
  });
  await expectStatus(signedIn, 201, "signing in");
  // What a browser sends back: the first `name=value` pair, without its attributes.
  const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const merchant = { cookie, ...json };

  const product = (await expectStatus(
    await fetch(`${origin}/admin/products`, {
      method: "POST",
      headers: merchant,
      body: JSON.stringify({ title: "A poster", variants: [{ sku: "POSTER-A2" }] }),
    }),
    201,
    "creating a Product",
  )) as { variants: { id: string; sku: string }[] };

  const variantId = product.variants[0]?.id ?? "";
  await expectStatus(
    await fetch(`${origin}/admin/variants/${variantId}/prices`, {
      method: "POST",
      headers: merchant,
      body: JSON.stringify({ amount: PRICED_AT }),
    }),
    201,
    "setting a Price",
  );

  const key = (await expectStatus(
    await fetch(`${origin}/admin/api-keys`, {
      method: "POST",
      headers: merchant,
      body: JSON.stringify({ name: "the gate's storefront", kind: "secret" }),
    }),
    201,
    "minting an API key",
  )) as { key: string };

  return { variantId, headers: { authorization: `Bearer ${key.key}` } };
}

/** The storefront's one question, asked identically before and after the upgrade. */
async function resolvedPrice(origin: string, store: StoreKeys): Promise<PriceBody> {
  return (await expectStatus(
    await fetch(`${origin}/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    }),
    200,
    "asking the store surface for a resolved price",
  )) as PriceBody;
}

async function expectStatus(
  response: Response,
  status: number,
  what: string,
): Promise<unknown> {
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status !== status) {
    // Every one of these is a step in the sequence the gate is testing, so the failure names
    // the step rather than leaving a status code to be traced back to one.
    throw new Error(
      `The gate could not get past ${what}: answered ${response.status}, expected ${status}. Body: ${JSON.stringify(body)}`,
    );
  }
  return body;
}
