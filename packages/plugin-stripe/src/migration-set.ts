import { fileURLToPath } from "node:url";
import { defineMigrationSet, type MigrationSet } from "@kobai/core/migrations";

/**
 * This Plugin's migration set — built by the same `defineMigrationSet` Core builds its own
 * with, from `@kobai/core/migrations`. There is one implementation of the machinery, so
 * "it works for Core" and "it works for a Plugin" are the same statement.
 *
 * Exporting it is the whole of the Plugin's installation story. It does nothing on import:
 * a Project wires it into `kobai.config.ts` deliberately, or the Plugin's table never
 * appears (ADR-0017).
 *
 * Resolved from this module's own location so it is correct whether the Plugin runs from
 * `src/` in this repository or from `dist/` inside a Project's `node_modules` — both live
 * one directory below the package root, so the hop is the same.
 */
export const stripeMigrationSet: MigrationSet = defineMigrationSet({
  name: "plugin-stripe",
  migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
});
