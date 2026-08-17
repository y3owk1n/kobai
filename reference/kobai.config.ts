import { defineKobaiConfig } from "@kobai/core";

/**
 * Everything this Project has customised, in one file.
 *
 * A Developer should be able to read this and know what their deployment does differently
 * from stock kobai. Right now: nothing. Wired Plugins and Step overrides land here as the
 * skeleton grows, and nothing an installed Plugin ships takes effect until it appears in
 * this file (ADR-0017).
 */
export default defineKobaiConfig({
  migrationSets: [],
});
