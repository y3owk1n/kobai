import { defineKobaiConfig } from "@kobai/core";
import { priceLogMigrationSet, recordPriceResolution } from "@kobai/plugin-price-log";
import { everythingCostsOneCent } from "./src/pricing/everything-costs-one-cent.ts";

/**
 * Everything this Project has customised, in one file.
 *
 * A Developer should be able to read this and know what their deployment does differently
 * from stock kobai. Three things, and nothing else: one Plugin's tables are wired, one Step
 * of Core's price-resolution Workflow is somebody else's now, and one Step the same Plugin
 * offers watches what that Workflow decided.
 *
 * `@kobai/core` is an ordinary versioned dependency in this Project's `package.json`, at the
 * same version it would be without either line. There is no fork, no copied service and no
 * patch — the customisation and the upstream never share a file (ADR-0001), which is what
 * makes upgrading a version bump rather than a merge.
 */
export default defineKobaiConfig({
  /**
   * `@kobai/plugin-price-log` is an ordinary dependency in this Project's `package.json` —
   * there is no bespoke installation mechanism, and installing it did nothing on its own. The
   * line below is what makes its table appear. Delete it and the Plugin is still installed,
   * still importable, and still inert (ADR-0017).
   */
  migrationSets: [priceLogMigrationSet],

  /**
   * The flagship (ADR-0003), exercised for real.
   *
   * `resolve-price` is Core's Workflow and `select-price` is one of its two Steps — the one
   * holding the rule about *which* Price applies. This Project disagrees with that rule and
   * says so here, by name, in the one file where every override lives. `load-prices` is not
   * mentioned and so is inherited unchanged: replacing a Step is not replacing the Workflow.
   *
   * A Step named here must satisfy the types of the slot it fills, checked by the compiler
   * rather than by a Merchant noticing wrong prices. Deliberately wrong prices are what this
   * one serves — see `src/pricing/everything-costs-one-cent.ts`.
   *
   * `after` is the weaker mechanism, and it sits beside `steps` rather than inside it so that
   * owning a Step and watching one are told apart at a glance. `recordPriceResolution` is a
   * Step `@kobai/plugin-price-log` **offers**; installing the Plugin did not install it, and
   * this line is what makes it run. Take the line out and the Plugin is still a dependency,
   * still imported by this file's neighbour above, and still writes nothing (ADR-0017). It
   * cannot change the price it watches — an inserted Step takes and gives the same type, so
   * observation cannot quietly become mutation.
   */
  workflows: {
    "resolve-price": {
      steps: { "select-price": everythingCostsOneCent },
      after: { "select-price": [recordPriceResolution] },
    },
  },
});
