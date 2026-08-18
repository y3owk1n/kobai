import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationsTableFor } from "@kobai/core/migrations";
import {
  createTestDatabase,
  inspectSchema,
  type TestDatabase,
} from "@kobai/core/testing";
import {
  LEAD_TIME_DAYS_KEY,
  LEAD_TIME_SURCHARGE_CODE,
} from "@kobai/plugin-made-to-order";
import { scaffold } from "create-kobai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type LocalRegistry,
  publishPackages,
  startLocalRegistry,
} from "./support/local-registry.ts";
import { packagesShippingAMigrationSet } from "./support/migration-sets.ts";
import { bootProject, runInProject } from "./support/project.ts";
import { publishedKobaiPackageDirectories } from "./support/workspace.ts";

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
 * Workflow, wired a Plugin's migration set, wired a Step that Plugin offers, supplies its own
 * Payment Provider, sells something a Plugin's Fulfilment Strategy answers for, and owns
 * tables of its own is moved across a Core major by the command kobai ships — and afterwards
 * it builds, boots, applies every migration set, serves a request against a real Postgres, the
 * replaced Step still decides the price, the Plugin's Strategy still answers, the Project's
 * Provider still takes payment, an Order placed before the upgrade reads back byte for byte,
 * and the Plugin's tables, rows and migration tracking are exactly as they were. Every step
 * is the one a Developer performs.
 *
 * **Two of those are dependency substitution, from each of the two places it can come from** —
 * a Project's own source and a Plugin's package (ADR-0052, ADR-0053) — which is the standard
 * #72 sets for the mechanism being credible. The third is ADR-0009: an Order is never edited,
 * and this is the only place in the repository that asks whether that survives a Core major.
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

/** The generated Project's `dependencies`, as they stand on disk right now. */
async function projectDependencies(): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return manifest.dependencies ?? {};
}

/**
 * The kobai half of a dependency block.
 *
 * The scope is the predicate because it is what `kobai-upgrade` moves and what the Project's
 * `.npmrc` points at — so a Plugin added to the reference Project is covered by this without
 * being named anywhere in this file.
 */
function kobaiRangesIn(dependencies: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => name.startsWith("@kobai/")),
  );
}

/** Filled in before anything else, so every message can name the two versions. */
let THIS_VERSION: string;
let SYNTHETIC_MAJOR: string;

/** Two installs, two builds, two boots and a dozen requests, on a cold runner. */
const GATE_TIMEOUT = 1_800_000;

/**
 * Every kobai package a generated Project resolves from a registry, and **deliberately not a
 * list of migration sets** (#129).
 *
 * The two overlap and are not the same question: `@kobai/client` is here and ships no
 * migrations, and a future Plugin that shipped none would be here too. What this is is
 * `create-kobai`'s own `PUBLISHED_KOBAI_PACKAGES` — the list the scaffolder uses to rewrite
 * a `workspace:*` into a version range — placed in the workspace by pnpm, so the packages a
 * generated Project asks for and the packages this test publishes are one list rather than
 * two copies of it. It is filled in `beforeAll` because that lookup shells out.
 */
let PUBLISHED: readonly string[];

let registry: LocalRegistry;
let workspace: string;
let project: string;
let database: TestDatabase;

/** Every `@kobai/*` range the generated Project carried before the upgrade ran. */
let kobaiRangesBefore: Record<string, string>;

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
  PUBLISHED = await publishedKobaiPackageDirectories();

  // The same packages, twice: once as this commit built them, and once as a major that does
  // not exist. See `PublishOptions.version` for why the second is a fair thing to make.
  await publishPackages(registry, PUBLISHED);
  await publishPackages(registry, PUBLISHED, { version: SYNTHETIC_MAJOR });

  workspace = await mkdtemp(join(tmpdir(), "kobai-upgrade-gate-"));
  project = join(workspace, "my-store");
  await scaffold({ directory: project });

  // What the Project depended on before the command touched it. Read off the scaffolded
  // manifest rather than typed out below, so a Plugin added to the reference Project is
  // covered here on the day it lands (#129) — and so a dependency the upgrade *dropped* is
  // as visible as one it failed to move.
  kobaiRangesBefore = kobaiRangesIn(await projectDependencies());

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
    //
    // **Every one it had, not three it was told to expect.** The list is the Project's own
    // manifest as it was scaffolded, so this covers a Plugin added to the reference Project
    // without an edit here, and it fails in the direction a list of names cannot: a
    // dependency the command *removed* is a key missing from the comparison rather than a
    // name nobody happened to check (#129).
    const kobaiRangesAfter = kobaiRangesIn(await projectDependencies());

    // A generated Project depends on Core and on at least one Plugin, and two empty objects
    // are equal — so the floor is what keeps the comparison from passing by finding nothing.
    expect(Object.keys(kobaiRangesBefore)).toContain("@kobai/core");
    expect(Object.keys(kobaiRangesBefore).length).toBeGreaterThan(1);

    expect(
      kobaiRangesAfter,
      `The Project's kobai dependencies did not all move to the new major. It had ${JSON.stringify(kobaiRangesBefore)} and now has ${JSON.stringify(kobaiRangesAfter)}.`,
    ).toEqual(
      Object.fromEntries(
        Object.keys(kobaiRangesBefore).map((name) => [name, `^${SYNTHETIC_MAJOR}`]),
      ),
    );

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

  it("still boots, and applies every migration set into the database it already had", async () => {
    // Criterion 5. Migrations are the part most likely to break across a major, and the
    // database here is the one the pre-upgrade Project wrote to.
    expect(
      after.health,
      `The upgraded Project did not report healthy. Its output:\n${after.logs}`,
    ).toMatchObject({ status: "ok" });

    // **The same Project, asked twice, either side of the boundary** — which is what this
    // file is for, and which no list of set names typed here could have said (#129). The
    // expectation is the pre-upgrade boot's own answer; nothing about it had to be written
    // down, and it fails in both directions: a set that vanished across the upgrade, and one
    // that appeared.
    expect(
      after.health.migrations.sets.map((set) => set.name),
      "A migration set went missing across the upgrade. Core's, each Plugin's and the Project's own are all applied by the same runner, so a set that vanished is a set the new version stopped wiring.",
    ).toEqual(before.health.migrations.sets.map((set) => set.name));

    // Two identical short lists agree, so the floor comes from somewhere neither boot could
    // have produced: pnpm and the journals on disk, saying how many packages this workspace
    // ships a migration set for. Only the count, because the *applied* half is asked of the
    // database rather than of `/health` two tests below — after an upgrade onto a database
    // that already held every migration, a set correctly applies nothing.
    const shippedSets = await packagesShippingAMigrationSet();
    expect(
      before.health.migrations.sets.map((set) => set.name),
      `The Project applied ${before.health.migrations.sets.length} migration set(s) before the upgrade and this workspace ships ${shippedSets.length} package(s) that own one: ${shippedSets.map((pkg) => pkg.name).join(", ")}.`,
    ).toHaveLength(shippedSets.length);
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

    // **Postgres's catalog against the application's own account of itself**, which is a
    // real question and not a restatement: `/health` reports the list the runner was handed,
    // and this reports the tables that actually exist. The names come from Core's own
    // `migrationsTableFor`, the function the runner derives them with, so a set reported as
    // applied and tracked nowhere fails here (#129).
    const tracking = await inspectSchema(database).migrationTracking();
    expect(
      tracking.map((fact) => fact.table).sort(),
      "A migration set's tracking table went missing, so the runner can no longer tell what it has applied. Core, each Plugin and the Project each track their own (ADR-0030).",
    ).toEqual(
      after.health.migrations.sets.map((set) => migrationsTableFor(set.name)).sort(),
    );

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

  it("still fulfils by the Plugin's Strategy, and charges what the Plugin's Step decides", () => {
    // **Dependency substitution, with the implementation coming from a Plugin** (ADR-0052,
    // ADR-0014). Core ships `physical` and `digital` and knows nothing else, so
    // `made-to-order` is on this Order only because `reference/kobai.config.ts` names the
    // Strategy `@kobai/plugin-made-to-order` offers. Were Core to answer here instead, a Store
    // that makes things to order would quietly begin claiming stock it does not keep.
    expect(
      fulfilmentAnswers(after.justPlaced),
      `The Plugin's Fulfilment Strategy stopped answering across the upgrade: an Order for ${MADE_TO_ORDER_SKU} came back fulfilled as ${JSON.stringify(fulfilmentAnswers(after.justPlaced))}. See \`fulfilment\` in reference/kobai.config.ts and ADR-0052.`,
    ).toEqual([
      {
        strategy: MADE_TO_ORDER_STRATEGY,
        requiresShipping: true,
        tracksInventory: false,
        hasLeadTime: true,
      },
    ]);

    expect(
      fulfilmentAnswers(after.justPlaced),
      "The Strategy answered one thing before the upgrade and another after it. What it answers is copied onto every Fulfilment at Capture (ADR-0009), so two Orders for the same Variant either side of a major have to record the same answers.",
    ).toEqual(fulfilmentAnswers(before.justPlaced));

    // ...and the answer reached something a Merchant can see. The Plugin's Step decides which
    // lines to surcharge from `hasLeadTime` rather than from the Strategy's name, so an
    // Adjustment on the Order is that answer carried end to end rather than merely reported —
    // and it is a value Core has never modelled, arriving from the open context (ADR-0013,
    // ADR-0022). Core's own `apply-adjustments` attaches nothing at all, so the slot silently
    // reverting to it is what this catches.
    expect(
      adjustmentsOn(after.justPlaced).map((adjustment) => adjustment.code),
      "The Lead Time surcharge stopped reaching the Order across the upgrade, so either the Step this Project put in `place-order`'s `apply-adjustments` slot stopped running or the Strategy stopped saying this line has a Lead Time. See `workflows` in reference/kobai.config.ts.",
    ).toEqual([LEAD_TIME_SURCHARGE_CODE]);

    // Two assertions rather than one, and the first is why the second cannot pass by
    // comparing two empty lists.
    expect(
      adjustmentsOn(after.justPlaced),
      `The Lead Time surcharge changed across the upgrade: the same Cart, asking for the same ${LEAD_TIME_DAYS}-day Lead Time, was charged differently either side of the major.`,
    ).toEqual(adjustmentsOn(before.justPlaced));
  });

  it("still takes payment through the Payment Provider this Project supplies", () => {
    // **Dependency substitution again, and this time out of the Project's own source**
    // (ADR-0053). Core defines `PaymentProvider` and implements it nowhere, so an Order
    // existing at all means this Project's `manual` one was reached — a deployment with none
    // refuses `place-order` with `no-payment-provider`, and `placeOrder` above would have
    // failed at 409 rather than getting here. What is left to say is that the record on the
    // Order is the answer *that* provider gives.
    expect(
      after.justPlaced.payment,
      "The Order placed after the upgrade carries no Payment record, so nothing took the money for it. Core ships no Payment Provider (ADR-0053) — see `payments` in reference/kobai.config.ts and reference/src/payments/manual.ts.",
    ).not.toBeNull();

    expect(
      after.justPlaced.payment,
      `The Payment on the Order does not read as this Project's own \`manual\` provider's work: it says provider ${JSON.stringify(after.justPlaced.payment?.provider)} and received ${JSON.stringify(after.justPlaced.payment?.received)}. \`received: false\` is what makes that provider honest — the money was arranged for out of band and has not arrived (reference/src/payments/manual.ts).`,
    ).toMatchObject({
      provider: "manual",
      received: false,
      amount: after.justPlaced.total,
      currency: after.justPlaced.currency,
    });
  });

  /**
   * **The strongest clause here, and the one nothing else in this repository asks.**
   *
   * ADR-0009 makes an Order the immutable financial record of a completed purchase: it is
   * never edited, so nothing — a migration, a rewritten read path, a column whose type moved
   * — may change what it says afterwards. This is that promise crossing a Core major.
   *
   * **What "byte-identical" means here: the whole response body of `GET /store/orders/{id}`,
   * compared as text.** Not a field-by-field match with the awkward parts excused — every
   * byte, so key order, number formatting and timestamp rendering are all in scope. That is
   * stricter than ADR-0009 by itself requires, and it is affordable for a reason peculiar to
   * this gate: the two versions are the same code under two version numbers (see "What it
   * does not prove" above), so those bytes have no legitimate way to differ. Anything that
   * moves them is a defect, and a Developer's storefront would have seen it.
   *
   * **What is deliberately excluded, and why.** The 201 body `POST /store/orders` answers
   * with carries `workflow` — an account of which Steps ran, which is a fact about one
   * request rather than about the record, and is why Core leaves it off the read route in the
   * first place. It also cannot be asked twice, because a Cart becomes exactly one Order. So
   * the subject is the read route, whose declared answer is "the Order, exactly as Capture
   * reported it". The Admin's view of the same Order is not compared either: that is one
   * record through a second projection, and a surface repeating what another already said is
   * not a second proof.
   */
  it("reads an Order placed before the upgrade back byte for byte", () => {
    // The guards first, because two identical nothings compare equal. What is compared below
    // has to be a real Order — the one that was arranged, numbered, paid for, with something
    // in it — before its bytes prove anything at all.
    expect(
      before.readBack.parsed.id,
      "The Order read back before the upgrade is not the one this gate arranged, so the comparison below is about the wrong record.",
    ).toBe(before.store.orderId);
    expect(
      before.readBack.parsed.number,
      "The Order this gate carries across the major has no Order number, so what is compared below is not an Order.",
    ).toBeGreaterThan(0);
    expect(
      before.readBack.parsed.payment,
      "The Order this gate carries across the major records no Payment, so half of what immutability is worth proving is not in these bytes.",
    ).not.toBeNull();
    expect(
      before.readBack.parsed.lineItems.length,
      "The Order this gate carries across the major has no Line Items, so its bytes hold no snapshot to be immutable about.",
    ).toBeGreaterThan(0);

    expect(
      after.readBack.bytes,
      `An Order was edited across the upgrade. ADR-0009 says an Order is never edited — it is the record a Merchant's books, a refund and a tax figure are all derived from — and \`GET /store/orders/${before.store.orderId}\` answered different bytes before and after the major, against the same database. The difference below is the edit.`,
    ).toBe(before.readBack.bytes);
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

/** An Adjustment as an Order reports it, less the parts that are new on every Order. */
type AdjustmentBody = {
  readonly code: string;
  readonly description: string;
  readonly amount: number;
};

/** What the Fulfilment Strategy answered at Capture, snapshotted onto the Order. */
type FulfilmentBody = {
  readonly strategy: string;
  readonly requiresShipping: boolean;
  readonly tracksInventory: boolean;
  readonly hasLeadTime: boolean;
};

type OrderBody = {
  readonly id: string;
  readonly number: number;
  readonly currency: string;
  readonly total: number;
  readonly payment: {
    readonly provider: string;
    readonly reference: string;
    readonly amount: number;
    readonly currency: string;
    readonly received: boolean;
  } | null;
  readonly lineItems: readonly {
    readonly adjustments: readonly AdjustmentBody[];
  }[];
  readonly fulfilments: readonly FulfilmentBody[];
};

/** An Order read back, and the bytes it was read back as. */
type ReadOrder = {
  /** The response body, untouched — what the byte-for-byte comparison is made of. */
  readonly bytes: string;
  /** The same thing parsed, for the assertions that guard that comparison from vacuity. */
  readonly parsed: OrderBody;
};

type StoreKeys = {
  /** The Variant a storefront asks the price of. */
  readonly variantId: string;
  /**
   * The Variant this Store makes to order — the one a Plugin's Fulfilment Strategy answers
   * for, and the only one either half of this gate ever buys.
   *
   * Made to order rather than stocked because that Strategy answers `tracksInventory: false`,
   * so buying it claims no Reservation and needs no Inventory row. The subject here is the
   * Strategy and the Provider surviving a major, and counting stock is a different test.
   */
  readonly madeToOrderVariantId: string;
  /** A secret API key's headers, for the store surface. */
  readonly headers: Record<string, string>;
  /**
   * The Order placed **before** the upgrade, and the one both halves read back.
   *
   * It is arranged rather than snapshotted, because ADR-0009's promise is about a record that
   * already existed when the new major arrived. See the byte-for-byte assertion below.
   */
  readonly orderId: string;
};

type Snapshot = {
  readonly store: StoreKeys;
  readonly health: {
    readonly status: string;
    readonly migrations: { readonly sets: readonly { name: string }[] };
  };
  readonly price: PriceBody;
  /** An Order this boot placed, so both halves answer the same question with fresh work. */
  readonly justPlaced: OrderBody;
  /** `store.orderId` — the Order arranged before the upgrade — read back by this boot. */
  readonly readBack: ReadOrder;
  readonly priceLog: readonly PriceLogRow[];
  readonly logs: string;
};

/**
 * Boots the Project, asks it the same questions, and stops it.
 *
 * `reach` is what differs between the two halves: the first arranges a Store and hands back
 * the keys to it, the second hands the same keys straight back. Everything after that —
 * health, the resolved price, an Order placed, the Order arranged before the upgrade read
 * back, the Plugin's rows — is asked identically, which is what makes the two snapshots
 * comparable at all.
 */
async function serve(
  directory: string,
  databaseUrl: string,
  reach: (origin: string) => Promise<StoreKeys>,
): Promise<Snapshot> {
  // Both boots are told the same first Merchant, which is what a redeployed compose file
  // does. The second finds one already there and creates nothing — an ordinary restart is
  // the commonest thing an upgrade is, so seeding has to survive being run twice here too.
  await using booted = await bootProject(directory, databaseUrl, {
    KOBAI_INITIAL_MERCHANT_EMAIL: MERCHANT.email,
    KOBAI_INITIAL_MERCHANT_PASSWORD: MERCHANT.password,
  });

  const health = (await (await fetch(`${booted.origin}/health`)).json()) as {
    status: string;
    migrations: { sets: { name: string }[] };
  };
  const store = await reach(booted.origin);

  return {
    store,
    health,
    price: await resolvedPrice(booted.origin, store),
    // **Placed by this boot**, so that what the Plugin's Fulfilment Strategy and the Project's
    // Payment Provider answer is asked again on the far side of the upgrade rather than
    // remembered. A Cart becomes exactly one Order, so each half builds its own.
    justPlaced: await placeOrder(booted.origin, store),
    // ...and the Order arranged *before* the upgrade, read back the way a storefront reloading
    // a confirmation page reads one. The same Order and the same request in both halves, which
    // is the whole of what makes comparing the bytes mean anything.
    readBack: await readOrder(booted.origin, store),
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
 * The Merchant both boots are configured with.
 *
 * A Project's first Merchant is seeded at boot from its environment and cannot be created
 * over HTTP (#25), so this is the one credential in this file that does not come from the
 * API — it goes *in*, as configuration, and everything below is arranged with the session it
 * opens.
 */
const MERCHANT = {
  email: "merchant@example.test",
  password: "a merchant's very long password",
};

/**
 * A Product, the one Variant that makes it sellable, and a Price on that Variant.
 *
 * Two of these are arranged and they differ in one field, so this is a helper rather than a
 * second copy of the shape. `fulfilmentStrategy` is spelled out rather than passed as
 * `fulfilment`, because the request body's `fulfilment` is an object and a caller here should
 * be naming a Strategy rather than assembling one.
 */
async function pricedVariant(
  origin: string,
  merchant: Record<string, string>,
  product: {
    readonly title: string;
    readonly sku: string;
    readonly fulfilmentStrategy?: string;
  },
): Promise<string> {
  const created = (await expectStatus(
    await fetch(`${origin}/admin/products`, {
      method: "POST",
      headers: merchant,
      body: JSON.stringify({
        title: product.title,
        variants: [
          {
            sku: product.sku,
            ...(product.fulfilmentStrategy === undefined
              ? {}
              : { fulfilment: { strategy: product.fulfilmentStrategy } }),
          },
        ],
      }),
    }),
    201,
    `creating the Product ${product.title}`,
  )) as { variants: { id: string }[] };

  const variantId = created.variants[0]?.id;
  if (variantId === undefined) {
    throw new Error(
      `The gate could not get past creating ${product.sku}: the Product came back with no Variants at all.`,
    );
  }

  await expectStatus(
    await fetch(`${origin}/admin/variants/${variantId}/prices`, {
      method: "POST",
      headers: merchant,
      body: JSON.stringify({ amount: PRICED_AT }),
    }),
    201,
    `setting a Price on ${product.sku}`,
  );

  return variantId;
}

/**
 * The Lead Time this gate's storefront asks for, in days.
 *
 * Shorter than the interval `@kobai/plugin-made-to-order` treats as ordinary, which is what
 * makes its Step attach an Adjustment at all. *How much* shorter costs *how much* is that
 * Plugin's terms, asserted in that Plugin's own tests; what this gate needs is that the same
 * question gets the same answer on both sides of the major.
 *
 * The key it is sent under and the code the resulting Adjustment carries are **the Plugin's**,
 * imported from it rather than copied here — Core has never heard of either, which is the whole
 * point (ADR-0013), and the Plugin exports them saying a test should not have to guess. So a
 * rename in the Plugin reaches this gate as a compile error rather than as a red assertion
 * about surcharges.
 */
const LEAD_TIME_DAYS = 3;

/** The name this Project wired the Plugin's Strategy under, and the Variant pointing at it. */
const MADE_TO_ORDER_STRATEGY = "made-to-order";
const MADE_TO_ORDER_SKU = "PRINT-COMMISSION";

/**
 * A Store with two priced Variants, arranged through the public API.
 *
 * Through the API rather than by writing rows, because that is all a storefront or a Merchant
 * can do — and because the arrangement itself is part of what has to keep working across the
 * upgrade.
 */
async function arrange(origin: string): Promise<StoreKeys> {
  const json = { "content-type": "application/json" };

  const signedIn = await fetch(`${origin}/admin/session`, {
    method: "POST",
    headers: json,
    body: JSON.stringify(MERCHANT),
  });
  await expectStatus(signedIn, 201, "signing in");
  // What a browser sends back: the first `name=value` pair, without its attributes.
  const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const merchant = { cookie, ...json };

  const variantId = await pricedVariant(origin, merchant, {
    title: "A poster",
    sku: "POSTER-A2",
  });

  // **The second Variant, and the one both halves of this gate actually buy.** It points at a
  // Fulfilment Strategy no build of Core ships: `made-to-order` exists only because
  // `reference/kobai.config.ts` wires the one `@kobai/plugin-made-to-order` offers (ADR-0052),
  // and a Variant may not point at a name this deployment has not wired — so creating it at
  // all is already half of what this gate is here to watch survive.
  //
  // It is bought rather than the poster because three customisations meet on it and on
  // nothing else: that Strategy, the Step the same Plugin offers in `place-order`'s
  // `apply-adjustments` slot, and the Payment Provider this Project supplies. The Strategy
  // also answers `tracksInventory: false`, so buying one claims no Reservation and needs no
  // Inventory row — scarcity is a different test's subject (ADR-0018).
  const madeToOrderVariantId = await pricedVariant(origin, merchant, {
    title: "A commissioned print",
    sku: MADE_TO_ORDER_SKU,
    fulfilmentStrategy: MADE_TO_ORDER_STRATEGY,
  });

  const key = (await expectStatus(
    await fetch(`${origin}/admin/api-keys`, {
      method: "POST",
      headers: merchant,
      body: JSON.stringify({ name: "the gate's storefront", kind: "secret" }),
    }),
    201,
    "minting an API key",
  )) as { key: string };

  const storefront = {
    madeToOrderVariantId,
    headers: { authorization: `Bearer ${key.key}` },
  };

  // **The Order this gate carries across the major.** Placed while the Store is still being
  // arranged, so that it is unambiguously older than the upgrade: every read of it from here
  // on is a read of a record that already existed when the new Core arrived (ADR-0009).
  const placed = await placeOrder(origin, storefront);

  return { variantId, ...storefront, orderId: placed.id };
}

/**
 * A storefront's whole purchase: a Cart, one made-to-order line, and the Order it becomes.
 *
 * Asked identically in both halves, and with fresh work each time — a Cart becomes exactly one
 * Order, so neither half can reuse the other's. What comes back is therefore what this build
 * of the Project decided just now, rather than what some earlier one recorded.
 *
 * The 201 carries an account of the Workflow run beside the Order, and this deliberately reads
 * none of it: which Steps ran is a fact about one request rather than about the record, and the
 * record is what these assertions are about.
 */
async function placeOrder(
  origin: string,
  storefront: Pick<StoreKeys, "headers" | "madeToOrderVariantId">,
): Promise<OrderBody> {
  const headers = { ...storefront.headers, "content-type": "application/json" };

  const cart = (await expectStatus(
    await fetch(`${origin}/store/carts`, { method: "POST", headers, body: "{}" }),
    201,
    "starting a Cart",
  )) as { id: string };

  await expectStatus(
    await fetch(`${origin}/store/carts/${cart.id}/line-items`, {
      method: "POST",
      headers,
      body: JSON.stringify({ variantId: storefront.madeToOrderVariantId, quantity: 1 }),
    }),
    200,
    "adding the made-to-order Variant to a Cart",
  );

  return (await expectStatus(
    await fetch(`${origin}/store/orders?${LEAD_TIME_DAYS_KEY}=${LEAD_TIME_DAYS}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cartId: cart.id }),
    }),
    201,
    "placing an Order",
  )) as OrderBody;
}

/**
 * One Order, read back over the store surface — and the bytes it came back as.
 *
 * `expectStatus` is deliberately not used: it parses, and what the byte-for-byte assertion
 * compares is the response body itself. The failure it reports says the same things.
 */
async function readOrder(origin: string, store: StoreKeys): Promise<ReadOrder> {
  const response = await fetch(`${origin}/store/orders/${store.orderId}`, {
    headers: store.headers,
  });
  const bytes = await response.text();

  if (response.status !== 200) {
    throw new Error(
      `The gate could not get past reading Order ${store.orderId} back: answered ${response.status}, expected 200. Body: ${bytes}`,
    );
  }
  return { bytes, parsed: JSON.parse(bytes) as OrderBody };
}

/** What the Fulfilment Strategy answered, less the identifiers new on every Order. */
function fulfilmentAnswers(order: OrderBody): readonly FulfilmentBody[] {
  return order.fulfilments.map((fulfilment) => ({
    strategy: fulfilment.strategy,
    requiresShipping: fulfilment.requiresShipping,
    tracksInventory: fulfilment.tracksInventory,
    hasLeadTime: fulfilment.hasLeadTime,
  }));
}

/** Every Adjustment on every line, less the identifiers new on every Order. */
function adjustmentsOn(order: OrderBody): readonly AdjustmentBody[] {
  return order.lineItems.flatMap((line) =>
    line.adjustments.map((adjustment) => ({
      code: adjustment.code,
      description: adjustment.description,
      amount: adjustment.amount,
    })),
  );
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
