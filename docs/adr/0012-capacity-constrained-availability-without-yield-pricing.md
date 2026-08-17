# Capacity-constrained availability, without yield pricing

Made-to-order Variants are constrained by finite production **Capacity**. A requested
delivery date is offered only if capacity exists for it, and capacity is consumed on order
capture. **Price** remains a deterministic function of **Lead Time** — it does not respond
to remaining capacity.

## Why capacity is not optional

A pure price curve with unlimited availability lets a Shopper buy a next-day print job when
the presses are already full for three days. That is taking money for something that cannot
be delivered — a business failure, not a modelling imprecision. Availability must be real
even in v1.

## Why not yield pricing

Demand-responsive pricing (airline-style, where scarcity moves the price) is a genuine
optimisation problem requiring demand data that does not exist yet. Crucially it is *the
same Workflow with a different Step* under ADR-0003, so deferring it costs nothing later.

## Consequences

Capacity is a first-class domain concept with a calendar, not a derived number — which
makes it the single largest addition to v1, accepted deliberately. "Time-based pricing" is
retired as a term: it conflates lead-time pricing (this ADR), yield pricing (deferred), and
scheduled price windows (already free under ADR-0008).
