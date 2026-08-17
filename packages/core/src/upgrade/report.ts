import type { UpgradeReport } from "./upgrade.ts";

/**
 * What the upgrade command prints.
 *
 * Separate from the work so the wording can be tested without capturing stdout, and because
 * the wording is a deliverable rather than a decoration: **the difference between "nothing
 * to do" and "did nothing" is what a Developer needs in order to trust this command the next
 * time, when the set is not empty.** A command that succeeds silently at an empty boundary
 * teaches nobody that it would have said something at a full one.
 */
export function formatUpgradeReport(report: UpgradeReport): string {
  const crossing = report.crossesMajor
    ? "across a major, which is the boundary codemods exist for"
    : "within a major";

  return [
    `kobai upgrade — @kobai/core ${report.from} → ${report.to}, ${crossing}.`,
    "",
    "Dependency ranges",
    ...rangeLines(report),
    "",
    "Install",
    "  `pnpm install` ran, so the version above is the one on disk.",
    "",
    "Codemods",
    ...codemodLines(report),
    "",
    summary(report),
  ].join("\n");
}

function rangeLines(report: UpgradeReport): string[] {
  const { changed, leftAlone } = report.ranges;

  const lines =
    changed.length === 0
      ? ["  Nothing to move: every kobai range already points at this version."]
      : (() => {
          const fileWidth = Math.max(...changed.map((change) => change.file.length));
          const nameWidth = Math.max(
            ...changed.map((change) => change.dependency.length),
          );
          return changed.map(
            (change) =>
              `  ${change.file.padEnd(fileWidth)}  ${change.dependency.padEnd(nameWidth)}  ${change.from} → ${change.to}`,
          );
        })();

  // Louder than the changes, because this is the one thing the command decided not to do.
  return [
    ...lines,
    ...leftAlone.map(
      (skipped) =>
        `  ! ${skipped.file}  ${skipped.dependency}  left at ${skipped.range} — ${skipped.why}`,
    ),
  ];
}

function codemodLines(report: UpgradeReport): string[] {
  const { codemods, from, to } = report;

  if (codemods.kind === "no-set-shipped") {
    return [
      `  ! @kobai/core ${to} ships no codemod set, so this command could not tell whether it`,
      "    had anything to migrate. That is not the same as having nothing: a version that",
      "    intends to ship none exports an empty set and says so.",
      `    ${codemods.why}`,
    ];
  }

  if (codemods.kind === "applied") {
    return [
      `  From ${codemods.source}:`,
      ...codemods.applied.flatMap((entry) => [
        `    ${entry.id} — ${entry.title}`,
        ...entry.changed.map((file) => `      changed ${file}`),
        ...(entry.changed.length === 0 ? ["      changed nothing in this Project"] : []),
      ]),
    ];
  }

  return [
    codemods.shipped === 0
      ? `  ${codemods.source} ships no codemods at all — nothing has needed migrating up to this version.`
      : `  ${codemods.source} ships ${codemods.shipped}, none of which applies to ${from} → ${to}.`,
    "  Nothing to migrate, which is not the same as nothing attempted: the set was read from",
    "  the version you upgraded to, so a release that ships one will be found by this same",
    "  command, run exactly this way.",
  ];
}

function summary(report: UpgradeReport): string {
  const moved = report.ranges.changed.length;
  const applied = report.codemods.kind === "applied" ? report.codemods.applied.length : 0;
  const done = `Moved ${moved} dependency range${moved === 1 ? "" : "s"}, applied ${applied} codemod${applied === 1 ? "" : "s"}.`;

  // The ranges moved and the install ran, so the last line must not read as a clean finish.
  return report.codemods.kind === "no-set-shipped"
    ? `${done} The codemod step did not run, so this upgrade is not finished.`
    : done;
}
