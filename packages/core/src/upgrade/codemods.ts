import { compareVersions, formatVersion, parseVersion, type Version } from "./version.ts";

/**
 * `@kobai/core/codemods` — what a version of Core ships to carry a Project across its own
 * breaking changes.
 *
 * ADR-0001 says upgrading kobai is "a version bump plus shipped codemods rather than a
 * merge". This module is the *shipped* half, and the reason it exists at `0.1.0` with an
 * empty set is that a runner which correctly runs nothing is a tested runner, and a runner
 * that does not exist is not. `tests/the-upgrade-gate.test.ts` runs it on every commit.
 *
 * ## A codemod is keyed to the version that broke something, not to a pair of versions
 *
 * {@link Codemod.introducedIn} names the version whose breaking change the codemod
 * migrates across, and {@link codemodsCrossing} runs every codemod whose `introducedIn`
 * falls in `(from, to]`. That is the whole resolution mechanism, and it is the part worth
 * getting right now because it is expensive to change later.
 *
 * The alternative — a map keyed by `from → to` — is what makes upgrade tooling rot. It is
 * O(n²) in releases, so either every new version rewrites every older entry or a Developer
 * upgrading two majors at once falls through a hole nobody enumerated. Keyed by the version
 * that introduced the change, a Project jumping `0.1.0` to `3.0.0` runs `1.x`'s, `2.x`'s and
 * `3.x`'s codemods in order, and the author of each one wrote it without knowing where
 * anybody would be upgrading from.
 *
 * ## The set is read from the version being upgraded *to*
 *
 * The runner that executes is whichever Core the Project had installed when the command
 * started; the set it applies is resolved out of the Project's `node_modules` *after* the
 * install, so it belongs to the version being moved to. That is what makes a codemod
 * something a release can add without every older Core having heard of it, and it is why
 * {@link CODEMOD_SET_FORMAT} exists: an old runner meeting a set it does not understand
 * says so and refuses, rather than applying nothing and reporting success.
 */

/**
 * The shape of this module's contract with the runner.
 *
 * Bumped only when {@link Codemod} changes in a way an older runner could not honour — the
 * first such change will be whatever a codemod needs in order to rewrite TypeScript rather
 * than JSON. That decision is deliberately not made here: TypeScript 7 ships no compiler
 * API, so an AST codemod means adopting a parser family kobai does not have, and adopting
 * one for an empty set would be the wrong time to choose.
 */
export const CODEMOD_SET_FORMAT = 1;

/** What a codemod is handed. The Project's own tree, and nothing of Core's. */
export type ProjectUnderUpgrade = {
  /** The Project's root: the directory holding its `package.json`. */
  readonly directory: string;
};

export type Codemod = {
  /**
   * Stable, unique, and never reused — a report names it and a Developer greps for it.
   *
   * By convention `<version>-<what-it-does>`, e.g. `1.0.0-workflow-context-is-a-map`.
   */
  readonly id: string;
  /** One imperative line, for the report. */
  readonly title: string;
  /** The version whose breaking change this migrates a Project across. */
  readonly introducedIn: string;
  /** Rewrites the Project in place, and answers with the paths it changed. */
  apply(project: ProjectUnderUpgrade): Promise<readonly string[]>;
};

/**
 * Every codemod this version of Core ships.
 *
 * **Empty, and that is the honest state.** `0.1.0` is the first version kobai published
 * (ADR-0034) and nothing has been broken since, so there is nothing to migrate across. The
 * gate crosses a synthetic major and runs this command for real, which proves the mechanism
 * that will carry the first real one.
 */
export const codemods: readonly Codemod[] = [];

/**
 * The codemods a Project moving `from → to` has to run, in the order it has to run them.
 *
 * Exclusive of `from` and inclusive of `to`: a Project already on `1.0.0` has run `1.0.0`'s
 * codemods, and a Project arriving at `1.0.0` has not.
 */
export function codemodsCrossing(
  set: readonly Codemod[],
  from: string,
  to: string,
): readonly Codemod[] {
  const after = parseVersion(from, "The version this Project is upgrading from");
  const until = parseVersion(to, "The version this Project is upgrading to");

  return set
    .map((codemod) => ({
      codemod,
      at: parseVersion(codemod.introducedIn, `Codemod ${codemod.id}'s \`introducedIn\``),
    }))
    .filter(({ at }) => compareVersions(at, after) > 0 && compareVersions(at, until) <= 0)
    .sort((a, b) => compareVersions(a.at, b.at) || (a.codemod.id < b.codemod.id ? -1 : 1))
    .map(({ codemod }) => codemod);
}

/**
 * A set loaded from somewhere, checked before anything is run from it.
 *
 * The check is the bootstrap: this runner may be older than the set it was handed, and the
 * only safe answers are "I understand this" and "I do not". Reporting zero codemods for a
 * set written to a contract this runner cannot read would be the worst of the three.
 */
export function readCodemodSet(loaded: unknown, source: string): readonly Codemod[] {
  const module = loaded as {
    CODEMOD_SET_FORMAT?: unknown;
    codemods?: unknown;
  };

  if (module.CODEMOD_SET_FORMAT !== CODEMOD_SET_FORMAT) {
    throw new Error(
      `${source} declares codemod set format ${JSON.stringify(module.CODEMOD_SET_FORMAT ?? null)}, and this upgrade command understands ${CODEMOD_SET_FORMAT}. It is refusing rather than reporting no codemods, because those are not the same answer. Upgrade in smaller steps, or run the command from the newer version.`,
    );
  }

  if (!Array.isArray(module.codemods)) {
    throw new Error(
      `${source} exports no \`codemods\` array, so this upgrade has no set to run and cannot tell an empty one from a missing one.`,
    );
  }

  for (const codemod of module.codemods as Codemod[]) {
    // Parsed here rather than where it is compared, so a malformed `introducedIn` names the
    // codemod that carries it instead of surfacing as a comparison that quietly excluded it.
    formatVersion(
      parseVersion(codemod.introducedIn, `Codemod ${codemod.id}'s \`introducedIn\``),
    );
  }

  return module.codemods as readonly Codemod[];
}

export type { Version };
