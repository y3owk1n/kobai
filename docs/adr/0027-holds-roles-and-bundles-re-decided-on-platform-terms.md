# Holds, roles and bundles, re-decided on platform terms

ADR-0024 voided the justification for three earlier decisions, each of which had been argued
from what a single low-volume printing store needs. Re-decided for a platform:

- **Reservation holds are in.** ADR-0018's single Reservation interface stands; its
  "check-and-consume at capture, no hold" implementation does not. Holds get a TTL and a
  sweeper. A commerce platform meets flash sales, limited drops and real contention, and
  "we oversell under contention" is not something it can say.
- **Merchant roles are in**, as **named roles carrying permission sets — not per-resource
  ACLs**. ADR-0020's single-role clause is void; agencies and brands have teams. The
  granular-permissions rabbit hole has consumed better-resourced projects, and a role can
  always be subdivided later.
- **Bundles are a Plugin, not a Core feature and not ruled out.** ADR-0022 was right that
  composition forks inventory, pricing and fulfilment — but that is precisely what
  Fulfilment Strategies (ADR-0014) and Workflow Steps (ADR-0017) exist to let a Plugin do.
  Bundles therefore become a good stress test of whether the strategy interface is real.

## Consequences

ADR-0018's atomicity requirement is unchanged and now matters more: with holds in play,
check, hold, consume and release must each be atomic, or the system has implemented the
appearance of safety rather than safety.
