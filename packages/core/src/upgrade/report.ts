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
    ...installLines(report),
    "",
    "Codemods",
    ...codemodLines(report),
    "",
    summary(report),
  ].join("\n");
}

/**
 * What the install did, including the file nobody asked it to touch.
 *
 * **An upgrade changes `pnpm-lock.yaml` as surely as it changes a manifest**, and a
 * Developer reading the diff afterwards should have been told that here rather than
 * discovering it in `git status`. It is also the line that explains the flag: the ranges
 * changed a moment earlier, so a frozen install would have refused by construction — which
 * is why this one install is allowed to move the lockfile and nothing else in a Project is.
 */
function installLines(report: UpgradeReport): string[] {
  const ran =
    "  `pnpm install --no-frozen-lockfile` ran, so the version above is the one on disk.";

  if (report.ranges.changed.length === 0) {
    return [
      ran,
      "  No range moved, so the lockfile had nothing to re-resolve and should be unchanged.",
    ];
  }

  return [
    ran,
    "  pnpm-lock.yaml was rewritten too, and had to be: the ranges above changed, so the",
    "  lockfile they had been resolved from was out of date the moment they did. Expect it",
    "  in the diff beside the manifests and commit it with them. Nothing else in your",
    "  Project installs any differently — that flag is scoped to this one install.",
  ];
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
