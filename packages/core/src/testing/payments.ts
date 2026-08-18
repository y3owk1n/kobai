import type { PaymentProvider } from "../payment/provider.ts";

/**
 * A Payment Provider that takes every payment and gives any of it back — what
 * {@link createTestKobai} wires when a test says nothing about payments.
 *
 * `silentLogger`'s counterpart, and there for the same reason: almost no test is *about* the
 * thing, and every test needs one for the application to work at all. Core ships no provider a
 * deployment could use (ADR-0053) and this is not one — it moves no money and remembers nothing,
 * so wiring it into a Store would take payment for every Order and hold none of it.
 *
 * **A test whose subject is payment should not reach for this.** Whether a decline leaves no
 * Order, and whether a failed Capture is refunded, are questions about a provider's *state* — so
 * that test writes a provider of its own, in the test, where what it does is visible. That is the
 * same line `seedTestCatalog` draws: a helper hides the arrangement a test does not care about
 * and never the thing the test is about.
 *
 * ```ts
 * await using kobai = await createTestKobai({ payments: {} }); // a deployment with none
 * ```
 */
export const testPaymentProvider: PaymentProvider = {
  name: "test",
  // A reference that is different every time and obviously not a real one, because Core stores
  // whatever a provider answers with and a test asserting on the record has to be able to tell
  // this apart from something meaningful.
  charge: async () => ({ ok: true, reference: `test-${crypto.randomUUID()}` }),
  refund: async () => {},
};
