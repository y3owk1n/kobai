import { applyEdits, modify } from "jsonc-parser";
import { REFERENCE_PROJECT_NAME, TEMPLATE_PROJECT_NAME } from "./naming.ts";

/**
 * The complete list of ways a generated Project differs from the reference Project.
 *
 * **This list is the honest part of `create-kobai`.** The reference Project is the Project
 * kobai's maintainers actually run (ADR-0029), and what a Developer receives has to be that
 * same Project — otherwise the scaffolder generates something nobody has tested. But the two
 * cannot be byte-identical, because one lives inside this workspace and one does not: the
 * reference Project reaches Core through `workspace:*` and a repository-root
 * `tsconfig.base.json`, and a Developer's Project reaches it through a registry and its own.
 *
 * So the differences are enumerated here, each with a reason, and
 * `tests/create-kobai-matches-the-reference-project.test.ts` fails on **any other
 * difference at all**. The value of that test is entirely a function of this list staying
 * short enough to read — a wildcard here, or an entry whose reason is "so the test passes",
 * removes the guarantee without removing the test. Anything genuinely shared belongs in the
 * reference Project, where it is exercised, rather than in a template nobody boots.
 */

/** Every kobai package a generated Project resolves from a registry rather than a workspace. */
export const PUBLISHED_KOBAI_PACKAGES = [
  "@kobai/core",
  "@kobai/plugin-price-log",
  "@kobai/plugin-made-to-order",
  "@kobai/plugin-stripe",
  "@kobai/client",
] as const;

/**
 * Files a generated Project has that the reference Project does not.
 *
 * All three exist because a generated Project is its own workspace and the reference Project
 * is a folder inside one. They are authored under `standalone/` rather than transformed from
 * anything, because there is nothing in the reference Project to transform — the repository
 * root owns its copies, and those are the repository's, not the Project's.
 */
export const STANDALONE_FILES: readonly { file: string; why: string }[] = [
  {
    file: "tsconfig.base.json",
    why: "The reference Project extends the repository root's, which carries `paths` mapping every `@kobai/*` specifier to workspace source so the editor and `typecheck` need no build first. A generated Project has no workspace source to point at — it resolves those specifiers from `node_modules` like any other dependency — so it needs a base config of its own with the compiler options and none of the mappings.",
  },
  {
    file: "pnpm-workspace.yaml",
    why: "A generated Project is a two-package workspace: itself and its vendored Admin. The reference Project needs no such file because the repository root's already lists it and `reference/admin` alike.",
  },
  {
    file: "gitignore",
    why: "`create-kobai` commits the Project it generates, so the Project needs to know what not to commit before that first commit happens. The reference Project is covered by the repository root's. Stored without the leading dot, and restored by `scaffold` — see DOTFILES_STORED_DOTLESS for why a real one here reaches no Developer.",
  },
];

/**
 * One difference between the two trees, named so a failure can say which one it is.
 *
 * `apply` takes the reference Project's bytes and returns the template's. It is the only
 * direction that exists: the reference Project is the source, the template is generated from
 * it by `devbox run template:generate`, and the test regenerates and compares — the same
 * shape `openapi.json` and `@kobai/client`'s `schema.ts` already use in this repository.
 */
export type Adaptation = {
  /** Path within the Project, POSIX-separated, or `"*"` for every text file. */
  readonly file: string;
  /** What differs and why, quoted verbatim when the drift test reports a mismatch. */
  readonly what: string;
  readonly apply: (contents: string) => string;
};

/** Rewrites a strict-JSON manifest, preserving the 2-space formatting Biome produces. */
function editJson(
  contents: string,
  edit: (json: Record<string, unknown>) => void,
): string {
  const json = JSON.parse(contents) as Record<string, unknown>;
  edit(json);
  return `${JSON.stringify(json, null, 2)}\n`;
}

/**
 * Rewrites one value in a JSONC file, leaving every comment and every byte of surrounding
 * formatting alone.
 *
 * `tsconfig.json` is JSON *with comments*, and the comments in these two carry the reasoning
 * for the settings around them. Parsing and re-serialising would silently delete all of it,
 * so this goes through `jsonc-parser` — which is what this repository already reaches for
 * when it needs to read a `tsconfig`, TypeScript 7 having shipped no compiler API at all.
 */
function editJsonc(contents: string, path: (string | number)[], value: unknown): string {
  return applyEdits(
    contents,
    modify(contents, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
}

/**
 * What the template needs to know about the workspace it is generated from.
 *
 * One field so far, and it is here rather than hardcoded because hardcoding it would be a
 * second copy of a version this repository already pins once.
 */
export type AdaptationContext = {
  /**
   * The pnpm the repository root pins, which the generated Project pins for itself.
   *
   * The reference Project carries no `packageManager` because the workspace root above it
   * does; a generated Project has no root above it at all. Without the pin it runs on
   * whatever pnpm the Developer happens to have, and that is not a small difference — pnpm
   * 10 fails an install outright when a dependency has an unapproved build script, so a
   * Project generated and tested under 9 falls over on 10 with an error about `esbuild`
   * that mentions nothing to do with kobai.
   */
  readonly packageManager: string;
  /**
   * The compiler and the Node types, at the versions the repository root pins.
   *
   * Same shape of problem as `packageManager` and the same fix. The reference Project
   * declares neither, because `tsc` and `@types/node` are the workspace root's
   * devDependencies and every package under it resolves them by walking up. A generated
   * Project is its own root, so nothing is above it to walk up to — without these its very
   * first `build` fails with `Cannot find type definition file for 'node'`, which names
   * nothing a Developer could act on.
   *
   * Taken from the root rather than written down here so they cannot drift from the
   * versions this repository actually builds and tests with.
   */
  readonly toolchain: Readonly<Record<string, string>>;
  /**
   * What a generated Project pins kobai at — a caret range over the version Core is at.
   *
   * Derived rather than written down, for the reason the two fields above are: a literal
   * here would be a second copy of a version this repository already pins, and the copy
   * would go stale silently. The failure it prevents is nasty — bump the packages to `0.2.0`
   * and a hardcoded `^0.1.0` leaves every generated Project asking a registry for something
   * that is no longer there, surfacing as a resolution error deep inside the acceptance test
   * rather than as anything naming this file.
   *
   * A range rather than an exact pin because this is an ordinary npm dependency and should
   * behave like one: a Developer gets patch and minor fixes and decides for themselves when
   * to cross a major. Crossing one is the event ADR-0029 makes a release gate, and #12 is
   * the CI job that proves it.
   */
  readonly kobaiVersionRange: string;
};

/** What a standalone Project needs from the workspace root's devDependencies. */
const TOOLCHAIN = ["typescript", "@types/node"] as const;

/**
 * Reads the context out of the two manifests that pin these things — the repository root's
 * for the toolchain, and Core's for the version a Project asks a registry for.
 */
export function contextFrom(
  rootManifest: string,
  coreManifest: string,
): AdaptationContext {
  const { packageManager, devDependencies = {} } = JSON.parse(rootManifest) as {
    packageManager?: string;
    devDependencies?: Record<string, string>;
  };

  const { version } = JSON.parse(coreManifest) as { version?: string };
  if (version === undefined || version === "0.0.0") {
    throw new Error(
      `@kobai/core's version is ${JSON.stringify(version ?? null)}, so a generated Project has no published version to depend on. See ADR-0034.`,
    );
  }

  if (packageManager === undefined) {
    throw new Error(
      "The repository root's package.json declares no `packageManager`, so a generated Project would have no pnpm version to pin and would run on whatever the Developer happens to have.",
    );
  }

  const toolchain: Record<string, string> = {};
  for (const name of TOOLCHAIN) {
    const range = devDependencies[name];
    if (range === undefined) {
      // Failing here beats generating a Project that cannot compile itself. The root having
      // stopped declaring one of these is a real change, and this is where it surfaces.
      throw new Error(
        `The repository root's package.json no longer declares ${name}, which a generated Project needs as its own devDependency because it has no workspace root above it to inherit one from.`,
      );
    }
    toolchain[name] = range;
  }

  return { packageManager, toolchain, kobaiVersionRange: `^${version}` };
}

export function adaptationsFor(context: AdaptationContext): readonly Adaptation[] {
  return [
    {
      file: "*",
      what: "the Project's own npm name, which a Developer chooses and the reference Project cannot",
      apply: (contents) =>
        contents.replaceAll(REFERENCE_PROJECT_NAME, TEMPLATE_PROJECT_NAME),
    },
    {
      file: "package.json",
      what: "`description`, which describes the reference Project's job in this repository rather than anything a Developer's Project does",
      apply: (contents) =>
        editJson(contents, (json) => {
          json.description = "A kobai Project.";
        }),
    },
    {
      file: "package.json",
      what: "the kobai dependencies, which are `workspace:*` inside this repository and an ordinary semver range outside it — the whole of ADR-0001's promise, and the reason this package exists",
      apply: (contents) =>
        editJson(contents, (json) => {
          json.dependencies = versioned(json.dependencies, context.kobaiVersionRange);
        }),
    },
    {
      file: "admin/package.json",
      what: "`description`, for the same reason as the Project's",
      apply: (contents) =>
        editJson(contents, (json) => {
          json.description =
            "The Admin, vendored into this Project. Source you own and edit (ADR-0010, ADR-0033).";
        }),
    },
    {
      file: "admin/package.json",
      what: "the kobai dependencies, for the same reason as the Project's",
      apply: (contents) =>
        editJson(contents, (json) => {
          json.devDependencies = versioned(
            json.devDependencies,
            context.kobaiVersionRange,
          );
        }),
    },
    {
      file: "tsconfig.json",
      what: "`extends`, which reaches the repository root's base config from inside the workspace and the Project's own outside it",
      apply: (contents) => editJsonc(contents, ["extends"], "./tsconfig.base.json"),
    },
    {
      file: "admin/tsconfig.json",
      what: "`extends`, for the same reason as the Project's",
      apply: (contents) => editJsonc(contents, ["extends"], "../tsconfig.base.json"),
    },
    {
      file: "admin/tsconfig.json",
      what: "the `@kobai/client` path mapping, which points at workspace source that a generated Project does not have — it resolves the package from `node_modules`, which is what `vite build` does in both trees anyway",
      apply: (contents) =>
        editJsonc(contents, ["compilerOptions", "paths"], { "@/*": ["./src/*"] }),
    },
    {
      file: "package.json",
      what: "`packageManager` and the TypeScript toolchain, which the reference Project inherits from the workspace root above it and a generated Project, having no root above it, has to carry itself",
      apply: (contents) =>
        editJson(contents, (json) => {
          json.packageManager = context.packageManager;
          json.devDependencies = sorted({
            ...(json.devDependencies as Record<string, string> | undefined),
            ...context.toolchain,
          });
        }),
    },
  ];
}

/** npm writes dependency blocks in name order, and so does everything that edits one. */
function sorted(block: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(block).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Every kobai `workspace:*` in a dependency block, swapped for the published range. */
function versioned(block: unknown, range: string): unknown {
  if (block === null || typeof block !== "object") return block;

  const dependencies = { ...(block as Record<string, string>) };
  for (const name of PUBLISHED_KOBAI_PACKAGES) {
    if (name in dependencies) dependencies[name] = range;
  }
  return dependencies;
}

/**
 * The reference Project's bytes for one file, as the template's.
 *
 * Applied in list order, so a later adaptation sees what an earlier one produced — which is
 * what lets the global rename run first and the manifest edits operate on already-renamed
 * text.
 */
export function adaptToTemplate(
  relativePath: string,
  contents: string,
  context: AdaptationContext,
): string {
  return adaptationsFor(context)
    .filter((adaptation) => adaptation.file === "*" || adaptation.file === relativePath)
    .reduce((text, adaptation) => adaptation.apply(text), contents);
}
