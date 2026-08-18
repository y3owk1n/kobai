import type { Payment } from "@kobai/client";
import { Badge } from "@/components/ui/badge";

/**
 * Where an Order's money stands — the one thing on these screens a Merchant must not read wrong
 * (spec story 61).
 *
 * Three answers, and they are three because collapsing any two of them loses money. **Paid** is
 * money in hand. **Awaiting payment** is a Payment a provider *arranged* rather than took — an
 * invoice, a bank transfer, cash at the counter, which is what this Project's own `manual`
 * provider does — so the sale is real and nobody has been paid yet. **No payment recorded** is an
 * Order kobai holds no account of the money for at all, which is every Order placed before the
 * Payment record existed.
 *
 * The middle one is the reason this component exists. Without it a manually settled Order looks
 * exactly like a completed one, and the Merchant who has to chase the invoice is the last person
 * to find out.
 *
 * It is a **badge and not a status**: nothing here is a step in a lifecycle and nothing moves
 * between these three, because an Order is immutable and `received` is a record of what the
 * provider answered (ADR-0056). "Awaiting payment" is therefore not styled as an error — for a
 * Store that invoices it is the ordinary path — but it is the loudest of the three, because it
 * is the one somebody has to act on.
 */
export function PaymentBadge({ payment }: { readonly payment: Payment | null }) {
  if (payment === null) {
    return <Badge variant="outline">No payment recorded</Badge>;
  }
  return payment.received ? (
    <Badge variant="secondary">Paid</Badge>
  ) : (
    <Badge>Awaiting payment</Badge>
  );
}
