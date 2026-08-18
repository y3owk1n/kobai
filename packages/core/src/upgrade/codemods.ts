/**
 * `@kobai/core/codemods` — what a version of Core ships to carry a Project across its own
 * breaking changes.
 *
 * ADR-0001 says upgrading kobai is "a version bump plus shipped codemods rather than a
 * merge". This module is the *shipped* half, and the reason it exists at `0.1.0` with an
 * empty set is that a runner which correctly runs nothing is a tested runner, and a runner
 * that does not exist is not. `tests/the-upgrade-gate.test.ts` runs it on every commit.
 *
 * **Everything in this file is a promise ADR-0019 makes permanent**, because it is what the
 * `./codemods` export resolves to. So it holds the contract and nothing else: the shape of a
 * codemod, the shape of what one is handed, the format number, and the set. Selecting from a
 * set and reading one belong to `set.ts`, which no Project can import.
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

/**
 * One codemod: what it is called, which version's break it migrates, and the rewrite itself.
 *
 * **`apply` is a property holding a function rather than a method** (#127), which is the spelling
 * every interface kobai asks somebody else to implement uses — `Logger`, `PaymentProvider`,
 * `ReservationProvider`, `FulfilmentStrategy`, `Step.run` — and for the identical reason:
 * TypeScript checks method parameters *bivariantly* and function-property parameters
 * *contravariantly*, so only this spelling makes a codemod that demands **more** than the runner
 * hands it a compile error rather than a runtime surprise. The mistake it catches is a plausible
 * one here — `apply: (project: ProjectUnderUpgrade & { kobaiVersion: string }) => …`, from a
 * codemod that wants to branch on where the Project is coming *from* — and the honest answer to
 * it is that a codemod may not ask: {@link Codemod.introducedIn} is the whole of the resolution
 * mechanism, and a codemod that read the origin version would be the `from → to` map this module
 * exists to avoid.
 *
 * Nothing outside Core declares a `Codemod` today — `@kobai/core` is the only package that ships
 * a set, and the set is empty — so the change is invisible in the way `ReservationProvider`'s was
 * rather than a break needing ADR-0058's licence. It is taken now for the same reason: the day a
 * codemod is written by somebody else, the shape is already the safe one.
 */
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
  readonly apply: (project: ProjectUnderUpgrade) => Promise<readonly string[]>;
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
