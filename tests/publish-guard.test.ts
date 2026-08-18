import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sectionOf } from "./support/records.ts";

/**
 * `private: true` used to be the only thing between a stray `pnpm publish` and npmjs.com,
 * and ADR-0034 removed it from four packages on purpose — a generated Project depends on
 * them as ordinary versioned dependencies, and `workspace:*` resolves nowhere outside this
 * workspace.
 *
 * So something else has to stand where it stood. `publishConfig.registry`, pinned at a
 * loopback address, is that something: npm resolves the publish target from it **before it
 * opens a connection**, and it beats `--registry` and `npm_config_registry` alike — measured
 * while building this, not assumed. A publish that reaches the public registry therefore has
 * to be a deliberate act by someone who worked around this line, rather than a command
 * someone typed in the wrong directory.
 *
 * This is ADR-0030's shape applied to a different danger: the primary control is that the
 * dangerous thing is not reachable by accident, and a test is what keeps the control in
 * place after the person who added it has gone.
 *
 * **This file holds a second thing, and it is here because a publisher arrives here first**
 * (#162). Removing a pin is the act every obligation kobai has taken on the strength of nothing
 * having been published falls due on, and those obligations were recorded in four separate
 * records that each assumed you had found the other three. ADR-0061 is now the one list; the
 * block at the foot of this file holds it to naming every place an obligation is argued, and
 * every one of those places to naming the list back. The refusals above name the record, so it
 * is what a publisher reads before an assertion here can be deleted.
 */

const repoRoot = new URL("../", import.meta.url);

/** Loopback, however it is spelled. Anything else is a registry on somebody else's machine. */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/;

type Manifest = {
  readonly path: string;
  readonly name?: string;
  readonly private?: boolean;
  readonly version?: string;
  readonly publishConfig?: { registry?: string };
};

async function packageManifests(): Promise<Manifest[]> {
  const entries = await readdir(new URL("packages/", repoRoot), { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());

  if (directories.length === 0) {
    // Failing open would make this whole file pass by checking nothing.
    throw new Error(
      "No packages were found, so no manifest was checked for a publish guard.",
    );
  }

  return Promise.all(
    directories.map(async (entry) => {
      const path = `packages/${entry.name}/package.json`;
      const json = JSON.parse(
        await readFile(fileURLToPath(new URL(path, repoRoot)), "utf8"),
      ) as Omit<Manifest, "path">;
      return { ...json, path };
    }),
  );
}

/** Every package this repository intends to publish — everything not marked private. */
const publishable = (manifests: Manifest[]) =>
  manifests.filter((manifest) => manifest.private !== true);

describe("publishing kobai has to be deliberate", () => {
  it("pins every publishable package's registry at a loopback address", async () => {
    const unguarded = publishable(await packageManifests())
      .filter((manifest) => !LOOPBACK.test(manifest.publishConfig?.registry ?? ""))
      .map(
        (manifest) =>
          `${manifest.path} → publishConfig.registry is ${JSON.stringify(manifest.publishConfig?.registry ?? null)}`,
      );

    expect(
      unguarded,
      "A publishable package with no loopback registry pin can be published to npmjs.com by a single mistyped command. See ADR-0034. If the pin is coming out on purpose, that is the act everything in docs/adr/0061-what-the-first-publish-owes.md falls due on — read the list before this assertion goes.",
    ).toEqual([]);
  });

  it("publishes something, so the guard is guarding a real thing", async () => {
    // The way this file stops meaning anything is every package going back to `private:
    // true` — at which point the assertion above passes over an empty list forever.
    const names = publishable(await packageManifests()).map((manifest) => manifest.name);

    expect(names).toContain("@kobai/core");
    expect(names).toContain("create-kobai");
  });

  it("has no release workflow, and names no npm registry, account or token anywhere", async () => {
    // kobai is early and npmjs.com is deliberately out of scope (ADR-0034). "Publishable"
    // was forced by criterion 3 of #11 — pnpm will not publish a `private: true` package to
    // any registry, local ones included — but *published* is a separate act, and this is
    // what keeps the two apart as the repository grows.
    //
    // It scans CI rather than manifests because that is where a publish would actually be
    // wired up, and because the manifest pin above is one careless edit from gone. Two
    // independent locks, so neither has to be the only one.
    const workflows = new URL(".github/workflows/", repoRoot);
    const offenders: string[] = [];

    for (const name of await readdir(workflows)) {
      if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
      const contents = await readFile(new URL(name, workflows), "utf8");

      for (const [pattern, what] of [
        [/\bnpm\s+publish\b/, "runs `npm publish`"],
        [/\bpnpm\s+publish\b/, "runs `pnpm publish`"],
        [/registry\.npmjs\.org/, "names the public registry"],
        [/NPM_TOKEN|NODE_AUTH_TOKEN/, "reads an npm token"],
      ] as const) {
        if (pattern.test(contents)) offenders.push(`.github/workflows/${name} ${what}`);
      }
    }

    expect(
      offenders,
      "Publishing kobai to npmjs.com is a decision nobody has taken yet. If it is being taken now, ADR-0034 is where it gets recorded, docs/adr/0061-what-the-first-publish-owes.md is what that decision owes first, and this assertion is what gets deleted — deliberately, not as collateral.",
    ).toEqual([]);
  });

  it("gives every published package a real version rather than 0.0.0", async () => {
    // `0.0.0` is not a starting point, it is an absence — and a generated Project pins a
    // caret range against whatever is here, so a version nobody chose is a range nobody
    // chose. ADR-0034 records why it is 0.1.0.
    const unversioned = publishable(await packageManifests())
      .filter(
        (manifest) => manifest.version === undefined || manifest.version === "0.0.0",
      )
      .map((manifest) => `${manifest.path} → ${manifest.version}`);

    expect(unversioned).toEqual([]);
  });

  it("keeps every published package's version in step", async () => {
    // They are released together and a generated Project pins one range for all of them, so
    // two versions here would mean a Project asking for a combination nothing ever tested.
    const versions = new Set(publishable(await packageManifests()).map((m) => m.version));

    expect([...versions]).toHaveLength(1);
  });
});

/**
 * The record that answers "what does the first publish owe?", and the only place that answers
 * it. Repository-relative, and named by the two refusals above that a publisher has to get past.
 */
const OWED = join("docs", "adr", "0061-what-the-first-publish-owes.md");

/**
 * One thing the first publish falls due on, and where its argument is written.
 *
 * ADR-0061 is the list; this is the list's index, and it exists so the gate can hold the two
 * ends together. Four correct records had each recorded an obligation against the same act and
 * none pointed at the others (#162), so what is checked is **reachability from either end**:
 * the record carries a section per obligation, that section names every place the argument
 * lives, and every one of those places names the record back.
 *
 * **What is not checked is whether an obligation has been discharged**, and that is a decision
 * rather than a gap. "Has a database been migrated from this checkout and kept?" is not a
 * question a process can ask, and a green gate reads as permission — so the one thing this file
 * does at the act itself is what it already did: refuse it, now naming the list. ADR-0061's
 * "What is asserted, and what cannot be" is the argument in full.
 */
type Obligation = {
  /** Short enough for a failure message to carry it. */
  readonly owes: string;
  /** The heading in ADR-0061, verbatim, under which the entry stands. */
  readonly under: string;
} & (
  | {
      /**
       * Argued by a record or a file of its own, which is the ordinary case: the reasoning
       * belongs where the decision it qualifies was made, and the list carries the entry.
       */
      readonly argued: "elsewhere";
      /** Repository-relative, at least one, each naming ADR-0061 in return. */
      readonly at: readonly [string, ...string[]];
    }
  | {
      /**
       * Argued in ADR-0061 itself, because no decision elsewhere qualifies it. Stated rather
       * than spelled as an empty list, so that "nowhere else" is something somebody wrote.
       */
      readonly argued: "in the list itself";
    }
);

/**
 * What the first publish owes, as of this commit.
 *
 * Adding to it is three edits — the section in ADR-0061, the pointer in whatever argues the
 * obligation, and the entry here — and ADR-0061 § "Where the next obligation goes" is the rule
 * that says so. **Removing an entry is a release decision**, not a tidy-up: each of these is
 * survivable only because nothing has been published.
 */
const OUTSTANDING: readonly Obligation[] = [
  {
    owes: "ADR-0058's licence to break a promised surface expires",
    under: "The licence to break a promised surface closes",
    argued: "elsewhere",
    at: [
      join(
        "docs",
        "adr",
        "0058-a-promised-surface-may-be-broken-until-the-first-release.md",
      ),
      join(
        "docs",
        "adr",
        "0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md",
      ),
    ],
  },
  {
    // The other end of this one is held by `tests/migrations-are-safe-against-populated-
    // tables.test.ts`, whose acknowledgement names this record and this heading and whose gate
    // holds the heading to naming the migration back (#161). So the section cannot be emptied
    // from either side.
    owes: "migration 0016 indexes a table that may already hold duplicates",
    under: "`0016` adds a unique index to a table that already exists",
    argued: "elsewhere",
    at: [join("tests", "migrations-are-safe-against-populated-tables.test.ts")],
  },
  {
    owes: "a version policy, a changelog, provenance, and what 0.1.0 promises",
    under: "A version policy, a changelog, provenance, and what `0.1.0` promises",
    argued: "elsewhere",
    at: [
      join(
        "docs",
        "adr",
        "0034-kobai-is-published-and-the-reference-project-is-what-create-kobai-generates.md",
      ),
    ],
  },
  {
    owes: "the version is bumped in a commit, with the artifacts regenerated in it",
    under: "The version is bumped in a commit, and the artifacts are regenerated in it",
    argued: "elsewhere",
    at: [
      join("packages", "core", "src", "http", "app.ts"),
      join("tests", "support", "local-registry.ts"),
    ],
  },
  {
    owes: "no manifest names a repository, and the licence text ships only because pnpm packs it",
    under:
      "A publishable manifest names no repository, and its licence text is the packer's doing",
    argued: "in the list itself",
  },
];

/** Repository-relative, spelled the way a record writes it whatever `join` produced here. */
const posix = (path: string) => path.split(sep).join("/");

/**
 * How a place names the record: by filename, because a record links its neighbours relatively
 * and a source file names one in a comment — and the filename is unique either way.
 */
const basenameOf = (path: string) => posix(path).split("/").at(-1) ?? path;

/** A repository file, or `null` if it is not there — which is a finding rather than a crash. */
const read = (path: string) =>
  readFile(fileURLToPath(new URL(posix(path), repoRoot)), "utf8").catch(() => null);

/**
 * Where an obligation's argument is written — empty for the one argued in the list itself.
 *
 * One reading of the union, so the two tests below cannot come to differ about what an entry
 * with no other home means.
 */
const sitesOf = (obligation: Obligation): readonly string[] =>
  obligation.argued === "in the list itself" ? [] : obligation.at;

describe("what the first publish owes is one list, and every entry point reaches it", () => {
  it("carries a section in that record for every obligation outstanding", async () => {
    // Failing open would be the whole of this file passing by checking nothing: an empty list
    // is indistinguishable from a list that has been discharged, and only one of those is a
    // thing anybody did.
    expect(OUTSTANDING.length).toBeGreaterThan(0);

    const record = await read(OWED);
    expect(record, `${OWED} is not there to read.`).not.toBeNull();

    const missing = OUTSTANDING.filter(
      (obligation) => sectionOf(record ?? "", obligation.under) === null,
    ).map((obligation) => `${obligation.owes} → no section "${obligation.under}"`);

    expect(
      missing,
      `${OWED} is what a publisher reads instead of four records they have never heard of. A section deleted or renamed out from under an obligation shortens that list without anybody deciding it should. See ADR-0061.`,
    ).toEqual([]);
  });

  it("names, in each obligation's own section, every place its argument lives", async () => {
    const record = (await read(OWED)) ?? "";

    const unnamed = OUTSTANDING.flatMap((obligation) => {
      const section = sectionOf(record, obligation.under) ?? "";
      return sitesOf(obligation)
        .filter((path) => !section.includes(posix(path)))
        .map((path) => `"${obligation.under}" does not name ${posix(path)}`);
    });

    // Deliberately whether the section names the file and not what it says about it: the
    // argument is prose, and a check that read it would be checking wording (#161).
    expect(
      unnamed,
      "An entry that does not say where its argument is written sends a publisher back to searching, which is what having one list was for. Name the file in the section, in the form the check reads: repository-relative, with forward slashes.",
    ).toEqual([]);
  });

  it("is named by every place an obligation is argued", async () => {
    const sites = OUTSTANDING.flatMap(sitesOf);
    expect(sites.length).toBeGreaterThan(0);

    const silent: string[] = [];
    for (const path of sites) {
      const contents = await read(path);
      if (contents === null) silent.push(`${posix(path)} is not there to read`);
      else if (!contents.includes(basenameOf(OWED))) {
        silent.push(`${posix(path)} does not name ${basenameOf(OWED)}`);
      }
    }

    expect(
      silent,
      "An obligation is only findable if the place that argues it names the list. This is the assertion that stops what the first publish owes fragmenting back into records that each assume you found the others (#162).",
    ).toEqual([]);
  });
});
