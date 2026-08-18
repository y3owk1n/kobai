import { defineKobaiConfig } from "@kobai/core";
import { priceLogMigrationSet, recordPriceResolution } from "@kobai/plugin-price-log";
import { projectMigrationSet } from "./src/migration-set.ts";
import { manualPaymentProvider } from "./src/payments/manual.ts";
import { everythingCostsOneCent } from "./src/pricing/everything-costs-one-cent.ts";

/**
 * Everything this Project has customised, in one file.
 *
 * A Developer should be able to read this and know what their deployment does differently from
 * stock kobai. Four things, and nothing else: one Plugin's tables are wired, one Step of Core's
 * price-resolution Workflow is somebody else's now, one Step the same Plugin offers watches what
 * that Workflow decided, and this Project supplies the Payment Provider — because kobai ships
 * none.
 *
 * The last of those is a different *kind* of customisation from the three before it, and the
 * distinction is worth reading for. A replaced Step changes a decision Core would otherwise have
 * made; a supplied Payment Provider fills a hole Core deliberately left, and without it this
 * deployment would serve its catalog and its Admin and refuse to place an Order (ADR-0053).
 *
 * `@kobai/core` is an ordinary versioned dependency in this Project's `package.json`, at the
 * same version it would be without either line. There is no fork, no copied service and no
 * patch — the customisation and the upstream never share a file (ADR-0001), which is what
 * makes upgrading a version bump rather than a merge.
 */
export default defineKobaiConfig({
  /**
   * Two migration sets, and they are here for different reasons.
   *
   * `@kobai/plugin-price-log` is an ordinary dependency in this Project's `package.json` —
   * there is no bespoke installation mechanism, and installing it did nothing on its own. The
   * line below is what makes its table appear. Delete it and the Plugin is still installed,
   * still importable, and still inert (ADR-0017).
   *
   * `projectMigrationSet` is this Project's **own**, covering the tables in `src/db/schema.ts`
   * that neither Core nor any Plugin has heard of. It is the same kind of object, applied by
   * the same runner, into its own tracking table — a Project owns tables on exactly the terms
   * a Plugin does. What a Project may additionally do, and a Plugin may not, is add columns to
   * those tables whenever it likes: `devbox run db:generate` and nothing else. Core's tables
   * stay closed to both (ADR-0004).
   */
  migrationSets: [priceLogMigrationSet, projectMigrationSet],

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

  /**
   * Dependency substitution (ADR-0003's third Extension Point), and the first implementation of a
   * named kobai interface that did not come from kobai.
   *
   * Core defines `PaymentProvider` and implements it nowhere on purpose: a provider Core shipped
   * would have left every implementation of every named interface Core's own, which is the exact
   * finding #72 reports against `Logger`. So the one that exists is this Project's own source, in
   * `src/payments/manual.ts`, wired here — and a Store that takes cards swaps that file's export
   * for an adapter around its processor and changes nothing else in this repository.
   *
   * A **subject** rather than a scalar, like `session` and `migrationSets`: the next thing this
   * deployment needs to say about its payments goes beside the provider (ADR-0050).
   *
   * Take this line out and the rest of this file still works. The catalog serves, the Admin
   * serves, and `POST /store/orders` refuses with `no-payment-provider` — a Store that cannot yet
   * be bought from is still a Store worth reading, and only a database that cannot be migrated
   * stops a boot (ADR-0048).
   */
  payments: { provider: manualPaymentProvider },
});
