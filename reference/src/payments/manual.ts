import { consoleLogger, type PaymentProvider } from "@kobai/core";

/**
 * This Project's Payment Provider, and **the only one there is** (ADR-0053).
 *
 * `@kobai/core` defines `PaymentProvider` and implements it nowhere, deliberately. Dependency
 * substitution is one of ADR-0003's five Extension Points and it had exactly one named interface
 * whose every implementation was Core's own, so what was proven was that the seam worked rather
 * than that anybody had put something of their own through it (#72). This file is the something
 * of their own: a Project's source, in a Project's repository, reached by Core through nothing but
 * the one line in `kobai.config.ts`. Nothing in `@kobai/core` knows it exists.
 *
 * **It moves no money, and that is what "manual" means.** A Merchant is paid out of band — a bank
 * transfer, an invoice, cash at the counter — and this provider's whole job is to say that the
 * arrangement was made and to give it a reference a person can quote. A Store that takes cards
 * replaces this file with an adapter around its provider's SDK and changes nothing else; the
 * payment method token that adapter needs arrives in `metadata`, which is ADR-0013's open context
 * and needs no change to Core either.
 *
 * It keeps no books of its own, so a refund here is a thing a human has to do rather than a call
 * this can make. Saying so on the log is therefore the whole of what it can honestly do — and
 * saying it *loudly*, because the case it is reporting is money that was arranged for an Order
 * that then failed to exist.
 */
export const manualPaymentProvider: PaymentProvider = {
  name: "manual",

  charge: async ({ amount, currency, shopper }) => {
    // A reference a Merchant can quote back — this provider's only artefact, since there is no
    // system behind it holding one. Core stores it on the Payment and never parses it.
    const reference = `manual-${crypto.randomUUID()}`;

    consoleLogger.info("payment to settle manually", {
      reference,
      amount,
      currency,
      shopper: shopper?.email ?? "guest",
    });

    // Never a decline. This provider has nothing to decline *with*: it is not asking a bank
    // anything, it is recording that somebody will be asked for the money. A Store that wants a
    // purchase refused before it becomes an Order puts that rule in a Step, where it can say why.
    return { ok: true, reference };
  },

  refund: async ({ reference, amount, currency }) => {
    // At `error` rather than `info`, and it is not a false alarm: kobai unwound a purchase that
    // had already been arranged for, and this provider cannot un-arrange it. Somebody has to
    // make sure this money is never collected.
    consoleLogger.error("manual payment must not be collected", {
      reference,
      amount,
      currency,
      reason: "the Order it was arranged for was not placed, and kobai has unwound it",
    });
  },
};
