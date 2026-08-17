import { defineKobaiConfig } from "@kobai/core";
import { priceLogMigrationSet } from "@kobai/plugin-price-log";

/**
 * Everything this Project has customised, in one file.
 *
 * A Developer should be able to read this and know what their deployment does differently
 * from stock kobai. Right now: one Plugin is wired, and nothing else. Step overrides land
 * here as the skeleton grows.
 *
 * `@kobai/plugin-price-log` is an ordinary dependency in this Project's `package.json` —
 * there is no bespoke installation mechanism, and installing it did nothing on its own. The
 * line below is what makes its table appear. Delete it and the Plugin is still installed,
 * still importable, and still inert (ADR-0017).
 */
export default defineKobaiConfig({
  migrationSets: [priceLogMigrationSet],
});
