/**
 * Just enough semver to order two kobai versions, and no dependency to do it.
 *
 * `semver` would be a production dependency of a published package for one comparison, and
 * everything this needs to order is a version kobai itself published — `major.minor.patch`,
 * because ADR-0034 chose `0.1.0` as the first honest one and ADR-0024 gives the platform a
 * single release target rather than a train of prereleases.
 *
 * A prerelease is **refused rather than guessed at**. Ordering `1.0.0-rc.1` against `1.0.0`
 * is where hand-rolled semver goes wrong, and an upgrade that silently skips a codemod
 * because it mis-ordered two versions is the exact failure this whole path exists to
 * prevent. When kobai ships a prerelease, this is the function that has to grow — and it
 * will say so rather than be quietly wrong first.
 */

export type Version = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(value: string, what: string): Version {
  const matched = PLAIN.exec(value.trim());
  if (matched === null) {
    throw new Error(
      `${what} is ${JSON.stringify(value)}, which this upgrade cannot order. It understands plain \`major.minor.patch\` versions only — a prerelease or build metadata needs a real semver comparison, and guessing at one would risk skipping a codemod rather than failing.`,
    );
  }

  const [, major, minor, patch] = matched as unknown as [string, string, string, string];
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
}

/** Negative when `a` is older, positive when newer, zero when the same. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** `0.1.0` and `1.0.0` are different majors; so are `0.1.0` and `0.2.0`. */
export function crossesMajor(from: Version, to: Version): boolean {
  // Below 1.0.0 the minor *is* the major — npm's caret range treats `^0.1.0` as `>=0.1.0
  // <0.2.0`, so `0.1.0` to `0.2.0` is exactly as breaking to a Project as `1.x` to `2.x`
  // and needs exactly the same codemods run. A check on `major` alone would call kobai's
  // entire pre-1.0 life one uneventful major and run nothing.
  if (from.major === 0 || to.major === 0) {
    return from.major !== to.major || from.minor !== to.minor;
  }
  return from.major !== to.major;
}

export function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}
