import { defineKobaiConfig } from "@kobai/core";
import {
  leadTimeSurcharge,
  madeToOrder,
  madeToOrderMigrationSet,
} from "@kobai/plugin-made-to-order";
import { priceLogMigrationSet, recordPriceResolution } from "@kobai/plugin-price-log";
import { stripeMigrationSet, stripePayments } from "@kobai/plugin-stripe";
import { projectMigrationSet } from "./src/migration-set.ts";
import { confirmationOutbox } from "./src/notifications/dispatch-notice.ts";
import { manualPaymentProvider } from "./src/payments/manual.ts";
import { stripeConfiguration } from "./src/payments/stripe.ts";
import { everythingCostsOneCent } from "./src/pricing/everything-costs-one-cent.ts";

/**
 * **Stripe, if this deployment has been given it.**
 *
 * All three of its settings or none — see `stripeConfiguration`, and `.env.example` for what
 * they are. A deployment given none is the ordinary one: it settles out of band through
 * `src/payments/manual.ts`, mounts no redirect routes and no webhook, and is a working Store
 * rather than a broken one. That is the same judgement Core makes about a deployment with no
 * Payment Provider at all (ADR-0053), and it is what lets kobai's own gate — which has no
 * Stripe secret and must never acquire one — run against this Project unchanged.
 *
 * Exported because `src/server.ts` needs the *same object*, not another one: the thing that
 * starts a payment before the redirect and the Payment Provider that confirms it afterwards
 * have to be one system, or `charge` is confirming somebody else's money (ADR-0070).
 */
const stripe = stripeConfiguration(process.env);

export const bank =
  stripe === null
    ? null
    : {
        configuration: stripe,
        provider: stripePayments({ secretKey: stripe.secretKey }),
      };

/**
 * **What this deployment does when kobai announces something** (ADR-0085).
 *
 * Exported for `bank`'s reason: the thing wired below and the thing anything else in this
 * Project reads have to be the *same object*, not another one, or the notices would be queued
 * where nobody is looking. `src/notifications/dispatch-notice.ts` is where what it does lives.
 */
export const confirmations = confirmationOutbox();

/**
 * Everything this Project has customised, in one file.
 *
 * A Developer should be able to read this and know what their deployment does differently from
 * stock kobai. **Six things, and nothing else**: three Plugins' tables are wired, one Step of
 * Core's price-resolution Workflow is somebody else's now, one Step a Plugin offers watches what
 * that Workflow decided, this Project supplies the Payment Provider — because kobai ships none —
 * this Store makes some of what it sells to order, which takes a Fulfilment Strategy and a
 * Step from a second Plugin, and this Store tells a Shopper when their parcel leaves.
 *
 * They are not all the same *kind* of customisation, and the distinctions are worth reading for:
 *
 * - **A replaced Step** changes a decision Core would otherwise have made — `select-price` below,
 *   and `apply-adjustments`.
 * - **An inserted Step** watches one without being able to change it.
 * - **A supplied dependency** fills a hole Core deliberately left: without a Payment Provider this
 *   deployment would serve its catalog and its Admin and refuse to place an Order (ADR-0053), and
 *   without the Fulfilment Strategy no Variant could point at `made-to-order` at all (ADR-0052).
 * - **A wired Subscriber** does something *after* kobai has already done it, and cannot change
 *   or undo what it hears about — which is the whole difference between it and a Step.
 *
 * `@kobai/core` is an ordinary versioned dependency in this Project's `package.json`, at the
 * same version it would be without any of these lines. There is no fork, no copied service and
 * no patch — the customisation and the upstream never share a file (ADR-0001), which is what
 * makes upgrading a version bump rather than a merge.
 */
export default defineKobaiConfig({
  /**
   * Four migration sets, and they are here for different reasons.
   *
   * `@kobai/plugin-price-log` is an ordinary dependency in this Project's `package.json` —
   * there is no bespoke installation mechanism, and installing it did nothing on its own. The
   * line below is what makes its table appear. Delete it and the Plugin is still installed,
   * still importable, and still inert (ADR-0017).
   *
   * `@kobai/plugin-made-to-order` is the same story a second time, which is the point of it
   * being here: nothing about the mechanism got bigger for there being two Plugins, and neither
   * of them has heard of the other. Its table exists because this line names its set, and it
   * holds what this Store's Shoppers asked for — see `fulfilment` and `place-order` below for
   * the two other lines that Plugin needs before it does anything at all.
   *
   * `@kobai/plugin-stripe` is the one whose set is wired here **whether or not its provider is
   * wired below**, and that is not an oversight. Whether this deployment takes cards is a
   * question about its environment — see `payments` — and a Plugin's tables are the Project's
   * to create either way: the migration set is what a deployment applies, and applying it is
   * how a database is ready for the day somebody fills in `STRIPE_SECRET_KEY` and restarts.
   * It is also the difference between a Plugin whose schema is exercised by kobai's own gate
   * and one whose tables no deployment here ever creates (ADR-0029).
   *
   * `projectMigrationSet` is this Project's **own**, covering the tables in `src/db/schema.ts`
   * that neither Core nor any Plugin has heard of. It is the same kind of object, applied by
   * the same runner, into its own tracking table — a Project owns tables on exactly the terms
   * a Plugin does. What a Project may additionally do, and a Plugin may not, is add columns to
   * those tables whenever it likes: `pnpm run db:generate` and nothing else. Core's tables
   * stay closed to both (ADR-0004).
   */
  migrationSets: [
    priceLogMigrationSet,
    madeToOrderMigrationSet,
    stripeMigrationSet,
    projectMigrationSet,
  ],

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
   *
   * **`place-order` is the second Workflow this Project has an opinion about**, and the opinion
   * is a Plugin's. Core's own `apply-adjustments` attaches no Adjustment — there is no discount
   * or surcharge Core could invent that would be right for anybody's Store — so this Store hands
   * the slot to `@kobai/plugin-made-to-order`, which charges for a short Lead Time. That Step
   * reads the lead time out of the **open** half of the Workflow context: a number Core has
   * never modelled, sent by the storefront, turned into an Adjustment on the Order (ADR-0013,
   * ADR-0022). Take this line out and a Shopper in a hurry pays the ordinary price.
   */
  workflows: {
    "resolve-price": {
      steps: { "select-price": everythingCostsOneCent },
      after: { "select-price": [recordPriceResolution] },
    },
    "place-order": {
      steps: { "apply-adjustments": leadTimeSurcharge },
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
   *
   * **This is also the line that decides whether this Store can take a bank redirect**, and the
   * answer is a deployment's rather than this file's. A payment the Shopper completes at their
   * bank is started by the *Project* before the redirect and confirmed by the Payment Provider
   * afterwards (ADR-0070), so the two have to be one object — which is exactly what `bank`
   * above is. Given Stripe's settings this Store takes cards, FPX and GrabPay through one
   * integration, and `src/server.ts` mounts the routes that settle them; given none it settles
   * out of band, as it always has, and mounts nothing. **Both are working deployments**, which
   * is the whole of story 17: misconfiguring payments must not take a Store down.
   *
   * `src/payments/fake-bank.ts` is a third object of the same shape, and it is why the two
   * interesting paths are testable at all: the gate boots this Project with it in place of
   * either, because Stripe's sandbox cannot be told to abandon or to let a hold lapse.
   */
  payments: { provider: bank?.provider ?? manualPaymentProvider },

  /**
   * Dependency substitution again, and this time the implementation comes from a **Plugin**
   * rather than from this Project's own source (ADR-0014, ADR-0052).
   *
   * Core ships `physical` and `digital` and knows nothing else about how a thing reaches a
   * Shopper. This Store also makes things to order — they ship, nothing is on a shelf to take
   * off, and there is an interval before delivery — so it wires the Strategy
   * `@kobai/plugin-made-to-order` offers, under the name its Variants point at. **The key is the
   * name**: the Strategy itself has none, exactly as a replaced Step is named by the slot it
   * fills, so what a Variant is fulfilled by is visible here rather than buried in a Plugin.
   *
   * Take this line out and two things happen, in this order: no Variant may be created pointing
   * at `made-to-order` any more, and any that already do can no longer be placed — `place-order`
   * refuses `unknown-fulfilment-strategy` rather than guessing that they are ordinary stock. The
   * Plugin is still installed and still importable throughout (ADR-0017).
   *
   * Core's own two are here whether or not this key is, so `physical` — which every other
   * Variant in this Store uses — is untouched by any of it.
   */
  fulfilment: { strategies: { "made-to-order": madeToOrder } },

  /**
   * ADR-0003's **fourth** Extension Point, and the one that had never existed in any form until
   * #322 (ADR-0085, #70).
   *
   * kobai emits a fact about something it did; this line is what makes anything happen about it.
   * A Merchant marks a Fulfilment dispatched through the Admin, kobai announces
   * `fulfilment-dispatched` once that transition has committed, and this Store queues the notice
   * it owes the Shopper — in `src/notifications/dispatch-notice.ts`, this Project's own source,
   * with no route replaced, no Step inserted and nothing in Core patched. That is story 22 of
   * #211, and it is the difference between an events surface and a promise of one.
   *
   * **Take this line out and nothing subscribes.** The module above is still imported, the
   * object it makes still exists, and kobai still emits — into a deployment that wired nobody,
   * which behaves exactly as one that had never heard of the Extension Point (ADR-0017). That
   * is the same claim `migrationSets` and `fulfilment` make, and it is asserted the same way in
   * `src/kobai.config.test.ts`.
   *
   * **A Subscriber is not a Step, and reading them side by side is the point.** A Step above
   * decides something and can refuse; this runs afterwards, is handed the payload and nothing
   * else, cannot refuse, is never retried, and one that threw would be logged and would change
   * nothing about what the Merchant was told. It is a place to *react* and not a place to put
   * work that must happen — kobai's events are in-process and at most once, which is why what
   * this one does is queue and return.
   */
  events: { subscribers: { "fulfilment-dispatched": [confirmations.tellTheShopper] } },
});
