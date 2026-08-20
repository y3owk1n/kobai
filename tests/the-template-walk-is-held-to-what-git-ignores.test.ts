import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectFiles } from "create-kobai";
import { describe, expect, it } from "vitest";
import {
  gitignoreMatchesAtEveryDepth,
  namesADirectory,
  negates,
  patternsIn,
  subject,
} from "./support/ignore-files.ts";
import { sectionOf } from "./support/records.ts";

/**
 * The walk that generates `packages/create-kobai/template/` from `reference/`, held to what
 * `.gitignore` says — one directory at a time, with every divergence written down (#279).
 *
 * `projectFiles` reads no ignore file and cannot, exactly as a `.dockerignore` cannot
 * (ADR-0068). It is a **third** ignore mechanism beside those two, keeping its own
 * `SKIPPED_DIRECTORIES` list by hand — and the failure that makes it worth a gate has a
 * peculiarly bad signature. A test boots the reference Project and uploads Media;
 * `filesystemMediaStorage` writes a real file under `reference/kobai-media/`; `.gitignore`
 * names that directory, so `git status` reports a clean tree; `pnpm run template:generate`
 * sweeps the file into the checked-in template anyway; and
 * `tests/create-kobai-matches-the-reference-project.test.ts` goes red naming a PNG nobody
 * committed. **No fast check can see it** — it only appears once something has actually run
 * the application, which means the gate is the first thing to know. That is #254, and it cost
 * a full CI round trip.
 *
 * `kobai-media` is now skipped and #254's guard case pins that one directory. **The next
 * runtime-artifact directory reproduces the whole thing**, because nothing connected the list
 * to the ignore file that already names such directories. This is that connection.
 *
 * **It asserts rather than derives, and that was the ruling rather than the shortcut.**
 * Deriving `SKIPPED_DIRECTORIES` from `.gitignore` outright is the obvious move and is not
 * right: `.gitignore` also names `.scratch/` and `.idea/`, which the walk does not skip and
 * arguably should not — the template is generated from tracked source, and "what git ignores"
 * and "what a generated template leaves out" only *mostly* coincide. So the rule is that every
 * directory `.gitignore` names at every depth is either skipped by the walk or carries an
 * exemption below, and the exemption list is the thing a reader can check.
 *
 * The `.gitignore` it reads is the repository root's, because that is the one governing the
 * tree the walk reads: `reference/` is a folder inside this repository and has no ignore file
 * of its own, exactly as the `.dockerignore` gate beside this one records for the same tree.
 *
 * **What it can judge is a directory, and that is the whole of it.** A `.gitignore` entry
 * ending in `/` can only name a directory, which is what makes the question answerable at all.
 * `.DS_Store`, `Thumbs.db`, `*.swp`, `*.tsbuildinfo`, `.env` and `.env.*` name a file or a
 * directory indifferently and git does not say which, so none of them is a claim about a
 * directory and none is read here; the walk's answer for files is `isSkippedFile`, and nothing
 * in this file judges it. **That leaves a gap, and it is named rather than papered over**:
 * `isSkippedFile` drops `.DS_Store`, `.env*` and `.tsbuildinfo` and drops neither `Thumbs.db`
 * nor a `*.swp`, so either of those left in `reference/` is swept into the template exactly as
 * #254's PNG was. Closing it means deciding whether the walk should skip them or exempt them,
 * and that is a decision #279's ruling did not take — it asked for directories — so it is left
 * as one somebody takes rather than guessed at here.
 * `.claude/worktrees/` is left out for the opposite reason and is the
 * sharper case — it is the only entry in the file with an interior slash, so git anchors it at
 * the repository root and does **not** ignore a `reference/.claude/worktrees` at all.
 * Demanding the walk skip it would be demanding the wrong thing, which is the same distinction
 * the `.dockerignore` gate beside this one had to learn (ADR-0068), and it is why both read
 * the ignore file through `tests/support/ignore-files.ts` rather than each their own way.
 */

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const referenceRoot = join(repoRoot, "reference");

/** A file put inside each fixture directory: nothing the walk drops for being the file it is. */
const KEPT = "kept.txt";
/** A directory to put a second copy of each fixture under, so depth is measured rather than assumed. */
const BELOW = "below";

/** The directory segments of one of the walk's POSIX paths, which is where a skip would show. */
function directorySegmentsOf(path: string): string[] {
  return path.split("/").slice(0, -1);
}

/**
 * Every directory `.gitignore` names, at every depth, in the shape the walk would meet it.
 *
 * Negations are dropped rather than resolved: a `!` pattern un-ignores, so it is not a claim
 * that anything is generated. The root `.gitignore` has exactly one, `!.env.example`, and it
 * names no directory — but dropping them is the reading rather than a fact about today's file.
 */
async function directoriesGitIgnores(): Promise<string[]> {
  const contents = await readFile(join(repoRoot, ".gitignore"), "utf8");

  return patternsIn(contents)
    .filter((pattern) => !negates(pattern))
    .filter(namesADirectory)
    .filter(gitignoreMatchesAtEveryDepth)
    .map(subject)
    .sort();
}

/**
 * Which of these directory names the walk skips — **measured**, by giving it a tree holding one
 * of each and reading what came back.
 *
 * `SKIPPED_DIRECTORIES` is private to `tree.ts` and should stay private: it is an internal of a
 * published scaffolder rather than anything a Developer has business with, and exporting it to
 * be read here would make this an assertion about a constant. What is wanted is an assertion
 * about the walk's *behaviour*, and the two differ in the way that matters most — a skip that
 * only applied at the root would satisfy the constant and let `reference/admin/kobai-media`
 * through.
 *
 * So each name is planted twice, once at the root of the throwaway tree and once under a
 * directory, and a name counts as skipped only when neither copy came back.
 */
async function skippedByTheWalk(names: readonly string[]): Promise<Set<string>> {
  const root = await mkdtemp(join(tmpdir(), "kobai-template-walk-"));

  try {
    await writeFile(join(root, KEPT), "");
    await mkdir(join(root, BELOW), { recursive: true });
    await writeFile(join(root, BELOW, KEPT), "");

    for (const name of names) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, KEPT), "");
      await mkdir(join(root, BELOW, name), { recursive: true });
      await writeFile(join(root, BELOW, name, KEPT), "");
    }

    const found = await projectFiles(root);

    // Failing open would be worse than failing. A walk that returned nothing at all would
    // report every name as skipped, which reads exactly like a correct repository — ADR-0049's
    // trap, arriving as a green build. The two controls are files no skip may ever touch.
    expect(found).toContain(KEPT);
    expect(found).toContain(`${BELOW}/${KEPT}`);

    const reached = new Set(found.flatMap(directorySegmentsOf));
    return new Set(names.filter((name) => !reached.has(name)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A directory `.gitignore` names that the walk nevertheless visits, and the judgement that
 * lets it — which is a **kind** rather than a sentence, for the reason
 * `tests/migrations-are-safe-against-populated-tables.test.ts` made it one: two unlike
 * judgements produce the identical finding, and told apart only by their prose they would be
 * one list of two meanings with a reader hunting for the argument that is theirs.
 *
 * The two here are genuinely unlike, and neither entry could take the other's kind:
 *
 * - `belongs-to-this-repository-not-a-project` is a directory **this repository's own
 *   workflow** creates, at the root of a checkout somebody is working in. Nothing that
 *   installs, builds or runs a *Project* makes one, so the walk has nothing to skip. It names
 *   the record that hands the directory out, because a convention nobody writes down is not
 *   one — and the check holds that record to naming it.
 * - `belongs-to-an-editor-not-a-project` is a directory a **Developer's own tools** create,
 *   wherever they are pointed. The walk's skip list is what a Project's build and run leave
 *   behind, which is a closed set somebody can reason about; every editor and operating system
 *   that will ever exist is not, and an ignore file is where an open-ended list of them
 *   belongs. So it names the ignore file the Project a Developer receives ships, which is
 *   where that answer actually lands for them.
 *
 * Each kind carries the one thing that would show it false, and there is a third that holds of
 * both regardless of kind: the directory being *there*, inside the tree the template is
 * generated from. The last test in this file is what looks, and it is what turns an exemption
 * from a note into a guard — the day one appears under `reference/`, the gate goes red naming
 * it rather than sweeping it into what every Developer receives.
 */
type Exemption = {
  /** The `.gitignore` entry's subject, exactly as `subject` renders it. */
  readonly directory: string;
} & (
  | {
      readonly because: "belongs-to-this-repository-not-a-project";
      /** Repository-relative path to the record that hands the directory out. */
      readonly recordedIn: string;
      /** The heading in it, verbatim, under which that record names the directory. */
      readonly under: string;
    }
  | {
      readonly because: "belongs-to-an-editor-not-a-project";
      /** Repository-relative path to the ignore file a generated Project carries. */
      readonly alsoIgnoredBy: string;
    }
);

/** One kind of exemption, so a reader's parameter cannot drift from the union's fields. */
type OfKind<Because extends Exemption["because"]> = Extract<
  Exemption,
  { because: Because }
>;

/** Why the record does not argue what the exemption says it does, or `null` where it does. */
async function whyTheRecordDoesNotHold(
  exemption: OfKind<"belongs-to-this-repository-not-a-project">,
): Promise<string | null> {
  const record = await readFile(join(repoRoot, exemption.recordedIn), "utf8").catch(
    () => null,
  );
  if (record === null) return `${exemption.recordedIn} is not there to read`;

  const section = sectionOf(record, exemption.under);
  if (section === null)
    return `${exemption.recordedIn} has no section "${exemption.under}"`;

  return section.includes(exemption.directory)
    ? null
    : `"${exemption.under}" in ${exemption.recordedIn} does not name it`;
}

/** Why the Project's own ignore file does not carry it, or `null` where it does. */
async function whyTheProjectDoesNotIgnoreIt(
  exemption: OfKind<"belongs-to-an-editor-not-a-project">,
): Promise<string | null> {
  const contents = await readFile(join(repoRoot, exemption.alsoIgnoredBy), "utf8").catch(
    () => null,
  );
  if (contents === null) return `${exemption.alsoIgnoredBy} is not there to read`;

  const ignored = patternsIn(contents)
    .filter((pattern) => !negates(pattern))
    .map(subject);

  return ignored.includes(exemption.directory)
    ? null
    : `${exemption.alsoIgnoredBy} does not name it, so a Developer's Project would not either`;
}

/**
 * Every exemption whose kind claims something that is not true, named with what it claimed.
 *
 * A kind is only worth having if being the wrong kind can fail, so each one is asked for its
 * own warrant here and the switch is exhaustive: a kind added without one does not compile,
 * which is the point at which somebody has to say what would show it false.
 */
async function reasonsThatDoNotHold(exemptions: readonly Exemption[]): Promise<string[]> {
  const problems = await Promise.all(
    exemptions.map(async (exemption) => {
      const unless = (why: string | null) =>
        why === null ? [] : [`${exemption.directory}: ${exemption.because}, but ${why}`];

      switch (exemption.because) {
        case "belongs-to-this-repository-not-a-project":
          return unless(await whyTheRecordDoesNotHold(exemption));
        case "belongs-to-an-editor-not-a-project":
          return unless(await whyTheProjectDoesNotIgnoreIt(exemption));
        default: {
          const unhandled: never = exemption;
          return unhandled;
        }
      }
    }),
  );

  return problems.flat();
}

/**
 * The directories `.gitignore` names that the walk visits anyway, each with the judgement that
 * lets it.
 *
 * It is not an allow-list. The assertion below is an equality, so an entry that stops being
 * produced fails just as loudly as a directory nobody has decided about: an exemption cannot
 * outlive its divergence, and adding a name to `SKIPPED_DIRECTORIES` obliges you to delete the
 * entry here rather than leaving it to widen what passes. Answering a finding here is a
 * decision written down, which is what this exists to force.
 */
const EXEMPT: readonly Exemption[] = [
  /**
   * `.idea/` is an editor's, and it is the one entry here a maintainer could genuinely produce
   * inside `reference/`: opening that folder in a JetBrains IDE is all it takes. It is exempt
   * rather than skipped because the walk's list is what a Project's install, build and run
   * leave behind — `node_modules`, `dist`, `.devbox` and `kobai-media`, a set somebody can
   * reason about and finish — and the editors and operating systems of the world are not that
   * set. A walk that tried to keep up with them would be a second, worse copy of an ignore
   * file, which is the arrangement ADR-0068 exists to stop producing.
   *
   * The Project a Developer receives ships a `.gitignore` of its own naming this directory, so
   * their `.idea` is already answered where it lands for them. `alsoIgnoredBy` is that file and
   * it is the half of the argument a check can hold: if a generated Project stops ignoring
   * `.idea`, the walk is the only thing left and this is a decision to retake rather than a
   * line to keep.
   */
  {
    directory: ".idea",
    because: "belongs-to-an-editor-not-a-project",
    alsoIgnoredBy: join("packages", "create-kobai", "standalone", "gitignore"),
  },
  /**
   * `.scratch/` is **this repository's** scratch space rather than a Project's. AGENTS.md hands
   * it to agents for anything not on the issue tracker, and it is written at the root of the
   * checkout being worked in; nothing that installs, builds or boots a Project produces one, so
   * there is nothing here for the walk to skip. A generated Project has no such convention and
   * ignores no such directory, which is why this cannot take the kind above.
   *
   * ADR-0068 is where that is written down — it is the ADR this whole rule descends from, and
   * the section named below is the one that records `.scratch/` leaving the lint gate's scope
   * for exactly the reason it is outside the walk's business. **That heading is load-bearing**:
   * renaming the section fails the gate, which is what stops the reason quietly evaporating
   * while the exemption stays.
   */
  {
    directory: ".scratch",
    because: "belongs-to-this-repository-not-a-project",
    recordedIn: join(
      "docs",
      "adr",
      "0068-gitignore-is-the-one-statement-of-what-a-checkout-generates.md",
    ),
    under: "Consequences",
  },
];

describe("the walk that generates the template", () => {
  it("skips every directory .gitignore names, but the ones exempted here", async () => {
    const ignored = await directoriesGitIgnores();

    // Two empty lists are equal, so the reading is asked to have found something before it is
    // believed — a `.gitignore` this could not parse would otherwise satisfy an empty EXEMPT.
    expect(ignored.length).toBeGreaterThan(0);

    const skipped = await skippedByTheWalk(ignored);

    // The equality is what makes this more than an allow-list: an entry in EXEMPT that the walk
    // has since started skipping fails here too, so an exemption cannot outlive its divergence.
    expect(
      ignored.filter((directory) => !skipped.has(directory)),
      "`.gitignore` names these directories and `projectFiles` walks into them anyway, so a file a run of the reference Project leaves in one is swept into `packages/create-kobai/template/` — where `git status` cannot show it to you and only the gate can (#254, ADR-0068). A directory received and not expected: add it to `SKIPPED_DIRECTORIES` in `packages/create-kobai/src/tree.ts`, or write down in `EXEMPT` here why the walk should visit it. One expected and not received is the same rule from the other end — the walk now skips a directory `EXEMPT` still excuses, so delete that entry rather than leaving it to widen what passes.",
    ).toEqual(EXEMPT.map((exemption) => exemption.directory).sort());
  });

  it("exempts nothing on a reason that does not hold", async () => {
    await expect(reasonsThatDoNotHold(EXEMPT)).resolves.toEqual([]);
  });

  it("can tell a directory the walk skips from one it does not", async () => {
    // The assertion above passes either because the walk skips what it should or because this
    // measurement reads nothing, and from the outside those look identical. So the measurement
    // is made to answer both ways on a pair whose answer is not in doubt.
    const skipped = await skippedByTheWalk(["node_modules", "a-directory-nothing-skips"]);

    expect([...skipped]).toEqual(["node_modules"]);
  });

  it("finds no exempted directory inside the Project the template is generated from", async () => {
    // The falsifier every exemption shares, and what turns each from a note into a guard. Each
    // one rests on the directory not being produced inside a Project; a file under one in
    // `reference/` says otherwise, and it says so *before* `pnpm run template:generate` puts
    // it in front of every Developer.
    //
    // Asked of `projectFiles` itself rather than of a directory listing, because an empty
    // directory sweeps nothing into anything and is not the failure. This is the same tree the
    // generator reads, at the moment it would read it.
    const files = await projectFiles(referenceRoot);
    expect(files.length).toBeGreaterThan(0);

    const exempted = new Set(EXEMPT.map((exemption) => exemption.directory));
    const swept = files.filter((path) =>
      directorySegmentsOf(path).some((segment) => exempted.has(segment)),
    );

    expect(
      swept,
      "These files sit inside a directory this test exempts the template walk from skipping, so generation will sweep them into `packages/create-kobai/template/`. Either the exemption is wrong and the directory belongs in `SKIPPED_DIRECTORIES`, or the files do not belong in `reference/`.",
    ).toEqual([]);
  });
});

/**
 * Both warrants above are asked of a repository where they hold, so `reasonsThatDoNotHold`
 * answers `[]` every time the gate runs and would answer `[]` just as contentedly if it read
 * nothing at all. The file argues that a kind is only worth having if being the wrong kind can
 * fail; that claim is worth exactly what has been seen to fail, so each branch is driven here
 * against an exemption written to offend.
 *
 * `reasonsThatDoNotHold` takes its list as an argument for this reason, which is the same shape
 * `tests/migrations-are-safe-against-populated-tables.test.ts` gives the acknowledgements it
 * checks.
 */
describe("an exemption whose reason does not hold", () => {
  const adr = join(
    "docs",
    "adr",
    "0068-gitignore-is-the-one-statement-of-what-a-checkout-generates.md",
  );

  it("names one whose record is not there to read", async () => {
    await expect(
      reasonsThatDoNotHold([
        {
          directory: ".scratch",
          because: "belongs-to-this-repository-not-a-project",
          recordedIn: join("docs", "adr", "0000-no-such-record.md"),
          under: "Consequences",
        },
      ]),
    ).resolves.toEqual([
      ".scratch: belongs-to-this-repository-not-a-project, but docs/adr/0000-no-such-record.md is not there to read",
    ]);
  });

  it("names one whose record has no such section", async () => {
    // The renaming case, which is what makes the heading load-bearing rather than decorative:
    // a record reorganised out from under an exemption leaves the exemption saying nothing.
    await expect(
      reasonsThatDoNotHold([
        {
          directory: ".scratch",
          because: "belongs-to-this-repository-not-a-project",
          recordedIn: adr,
          under: "A heading nobody wrote",
        },
      ]),
    ).resolves.toEqual([
      `.scratch: belongs-to-this-repository-not-a-project, but ${adr} has no section "A heading nobody wrote"`,
    ]);
  });

  it("names one whose record has the section and does not name the directory", async () => {
    // A real section of a real record, which does not mention this directory — the case a
    // reader would most easily believe held, because both paths in the entry resolve.
    await expect(
      reasonsThatDoNotHold([
        {
          directory: ".jj",
          because: "belongs-to-this-repository-not-a-project",
          recordedIn: adr,
          under: "Consequences",
        },
      ]),
    ).resolves.toEqual([
      `.jj: belongs-to-this-repository-not-a-project, but "Consequences" in ${adr} does not name it`,
    ]);
  });

  it("names one the Project a Developer receives does not ignore", async () => {
    const gitignore = join("packages", "create-kobai", "standalone", "gitignore");

    await expect(
      reasonsThatDoNotHold([
        {
          directory: ".vscode",
          because: "belongs-to-an-editor-not-a-project",
          alsoIgnoredBy: gitignore,
        },
        {
          directory: ".idea",
          because: "belongs-to-an-editor-not-a-project",
          alsoIgnoredBy: join("packages", "create-kobai", "standalone", "no-such-file"),
        },
      ]),
    ).resolves.toEqual([
      `.vscode: belongs-to-an-editor-not-a-project, but ${gitignore} does not name it, so a Developer's Project would not either`,
      `.idea: belongs-to-an-editor-not-a-project, but packages/create-kobai/standalone/no-such-file is not there to read`,
    ]);
  });
});
