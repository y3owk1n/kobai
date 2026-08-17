# One release target: "v1" and "1.0" are the same thing

Supersedes ADR-0021. There is no milestone split. kobai has a single release target — the
platform in full — and "v1" and "1.0" name the same thing. The printing store that
prompted much of this design is **not** the scoping device for it, and should not be
treated as one.

## What this replaces

ADR-0021 separated a first shippable release from the envisioned platform, on the argument
that a live store would exercise the architecture before more was built on top of it. That
sequencing is rejected: kobai is being designed as a product, and its release target is
what the product should be, not what one store happens to need.

## Consequences

- **The architecture ships without production validation.** ADR-0001, 0003, 0013, 0014 and
  0017 remain an untested bet, and ADR-0011 remains an unverified risk. The compensating
  test both ADR-0007 and ADR-0013 relied on — a real store exercising the extension
  surface — no longer occurs as a side effect of shipping, and must be replaced by
  something deliberate.
- **Three decisions lose their justification.** ADR-0018 (no Reservation holds), ADR-0020
  (a single Merchant role) and ADR-0022 (Bundles ruled out) were each argued from what a
  single low-volume printing store needs. Those arguments are void and each decision is
  re-examined on platform terms.
- ADR-0007's remaining clauses stand: kobai is a project rather than a business, MIT, with
  no paid tier and no hosted offering.
