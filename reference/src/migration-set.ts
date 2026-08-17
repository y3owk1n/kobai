import { fileURLToPath } from "node:url";
import { defineMigrationSet, type MigrationSet } from "@kobai/core/migrations";

/**
 * This Project's migration set — built by the same `defineMigrationSet` Core builds its own
 * with, and a Plugin builds its own with. There is one implementation of the machinery, so
 * "it works for Core" and "it works for my Project" are the same statement.
 *
 * Unlike a Plugin's, this one is offered to nobody: it is wired into this Project's own
 * `kobai.config.ts` beside the Plugin's, which is the only place it could be wired. A
 * Project is the thing that does the wiring (ADR-0017).
 *
 * **Found through the module resolver, not by counting `..` segments** — the same care
 * `src/admin-assets.ts` takes, for the same reason and with a sharper edge here. A Plugin
 * gets away with `new URL("../migrations", import.meta.url)` because its source sits at
 * `src/x.ts` and its build at `dist/x.js`, both one hop below the package root. This
 * Project's build keeps `src/` (`tsconfig.build.json` sets `rootDir: "."`), so this module
 * runs from `src/` under `--watch` and from `dist/src/` in the container — **different
 * depths**, and a relative path correct in one is silently wrong in the other. It would not
 * throw; it would find no journal and apply no migrations, which is the quietest possible
 * way for a Project's own tables to never appear.
 *
 * Resolving this Project's own `package.json` by name is right at both depths, because it
 * is the same lookup an `import` would do. It works because the manifest names itself in
 * `exports` — Node lets a package self-reference when it does.
 */
export const projectMigrationSet: MigrationSet = defineMigrationSet({
  name: "project",
  migrationsFolder: fileURLToPath(
    new URL("migrations/", import.meta.resolve("kobai-reference/package.json")),
  ),
});
