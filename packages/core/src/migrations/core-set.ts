import { fileURLToPath } from "node:url";
import { defineMigrationSet, type MigrationSet } from "./set.ts";

/**
 * Core's own migration set — one entry in the same list a Plugin's set goes into, applied
 * by the same runner. Core dogfoods the mechanism it asks Plugins to use, so a later split
 * of Core into finer packages is mechanical rather than architectural (ADR-0025).
 *
 * Resolved from this module's own location so it is correct whether Core is running from
 * `src/` in this repository or from `dist/` inside a Project's `node_modules`. Both live one
 * directory below the package root, so the hop is the same.
 */
export const coreMigrationSet: MigrationSet = defineMigrationSet({
  name: "core",
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
});
