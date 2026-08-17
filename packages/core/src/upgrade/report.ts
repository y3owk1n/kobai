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
  const lines: string[] = [];

  const crossing = report.crossesMajor
    ? "across a major, which is the boundary codemods exist for"
    : "within a major";
  lines.push(
    `kobai upgrade — @kobai/core ${report.from} → ${report.to}, ${crossing}.`,
    ...(report.dryRun
      ? ["", "A dry run: nothing below was written, installed or run."]
      : []),
    "",
    "Dependency ranges",
  );

  if (report.ranges.changed.length === 0) {
    lines.push("  Nothing to move: every kobai range already points at this version.");
  } else {
    const width = Math.max(...report.ranges.changed.map((change) => change.file.length));
    const name = Math.max(...report.ranges.changed.map((c) => c.dependency.length));
    for (const change of report.ranges.changed) {
      lines.push(
        `  ${change.file.padEnd(width)}  ${change.dependency.padEnd(name)}  ${change.from} → ${change.to}`,
      );
    }
  }

  for (const skipped of report.ranges.leftAlone) {
    // Louder than the changes, because this is the one thing the command decided not to do.
    lines.push(
      `  ! ${skipped.file}  ${skipped.dependency}  left at ${skipped.range} — ${skipped.why}`,
    );
  }

  lines.push(
    "",
    "Install",
    report.installed
      ? "  `pnpm install` ran, so the version above is the one on disk."
      : "  Skipped. Install before running any codemod: the set that runs is the one the version you are moving to ships, and it is not on disk until you do.",
    "",
    "Codemods",
    ...codemodLines(report),
    "",
    summary(report),
  );

  return lines.join("\n");
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

  if (!report.installed) {
    return [`  Not read: ${codemods.source}`];
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
  const verb = report.dryRun ? "Would move" : "Moved";

  return `${verb} ${moved} dependency range${moved === 1 ? "" : "s"}, applied ${applied} codemod${applied === 1 ? "" : "s"}.`;
}
