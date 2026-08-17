# v1 ships one real order; 1.0 is the envisioned platform

> **Superseded by [ADR-0024](./0024-one-release-target-v1-and-1-0-are-the-same-thing.md).**
> There is no milestone split; "v1" and "1.0" name the same single release target, and the
> printing store is not the scoping device. Retained for the record.

Supersedes the scope clause of ADR-0007. "v1" was doing two jobs — the first thing that
ships, and the complete thing kobai is meant to be — so they are now named separately.
**v1** is the printing store taking and fulfilling a real order. **1.0** is the envisioned
platform, including the content platform of ADR-0023. Milestones sit in between. Nothing
from the vision is cut; it is ordered.

## Why not build the whole vision before shipping

The argument is feedback, not caution. ADR-0001, 0003, 0013, 0014 and 0017 are a coherent
architectural bet that no code has tested, and ADR-0011 records a known unverified risk that
could force one of them to be superseded. Building the entire platform on an unexercised
architecture is the most expensive available way to be wrong.

More specifically: ADR-0013 made the printing store the test of the flagship extension
mechanism. **That test only runs once the store runs.** Every decision made after the store
is live is informed by production reality rather than by a design conversation.

## Consequences

ADR-0007's other clauses stand unchanged — kobai remains a project rather than a business,
MIT with no paid tier, with agencies as the target segment and a single brand as the first
customer. Only the definition of the scope boundary moves.
