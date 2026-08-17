import { CODEMOD_SET_FORMAT, type Codemod } from "./codemods.ts";
import { compareVersions, parseVersion } from "./version.ts";

/**
 * Choosing from a codemod set, and reading one a newer version shipped.
 *
 * Deliberately **not** part of `@kobai/core/codemods`. That specifier is a promise ADR-0019
 * makes permanent, and a Project needs the contract in order to have a codemod written
 * against it — it never needs the runner's own machinery. Keeping these here is what stops
 * the surface growing to the size of the implementation.
 */

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
 * The version being upgraded to exports no codemod set at all.
 *
 * Its own error type because it is the **only** load failure the command may survive. Every
 * other one — a set written to a format this runner cannot read, a set that is not an array,
 * a codemod whose version cannot be ordered — means kobai shipped something this command
 * must not guess about, and guessing would look exactly like an empty set.
 */
export class CodemodSetMissing extends Error {}

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
    // Parsed for its throw, here rather than where it is compared: a malformed `introducedIn`
    // should name the codemod that carries it, not surface later as a comparison that quietly
    // excluded one.
    parseVersion(codemod.introducedIn, `Codemod ${codemod.id}'s \`introducedIn\``);
  }

  return module.codemods as readonly Codemod[];
}
