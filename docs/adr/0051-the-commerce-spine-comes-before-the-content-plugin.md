# The commerce spine comes before the content Plugin

Amends [ADR-0029](./0029-the-reference-project-is-the-release-gate-and-content-is-built-first.md).
The next spec after the walking skeleton is the **commerce spine** — Cart, Line Item, Order,
Adjustment, Reservation and the `place-order` Workflow. The content Plugin follows
immediately, and still comes before catalog breadth, tax, shipping, Returns and
Translations.

**ADR-0029's rule is unchanged and is the reason for this.** The hardest available proof of
the extension surface is built earliest, because built last the surface is discovered to be
wrong last. What moves is only the clause naming *which* case that is.

## What changed is the input, not the rule

ADR-0029 reasons from one named proof. kobai has since named **three**, in three different
ADRs, and nothing had put them beside each other:

- **content** — ADR-0023 and ADR-0029: "the most demanding thing anyone will ever try to
  build on kobai's extension surface."
- **made-to-order** — ADR-0014: "if made-to-order cannot be expressed as a strategy Plugin,
  the strategy interface is wrong."
- **bundles** — ADR-0027: "a good stress test of whether the strategy interface is real."

**Two of the three are unbuildable today.** Made-to-order needs Capacity, Lead Time and
Adjustments; bundles fork inventory, pricing and fulfilment. Both wait behind the spine.
Content is the only one that can be built now — and it can be built now *precisely because*
it stands furthest from commerce, which is the same property that makes it the shallowest
test of the surfaces that already exist.

So "hardest" turns out to have two axes that point at different cases. **Breadth** is how
many Extension Points a case forces into existence, and content wins it outright: it demands
events (#70), Admin UI slots (#71) and Media substitution (#72), all three of which
`docs/extension-points.md` records as `promised only` or `partial`. **Depth** is how hard a
case leans on the surfaces that do exist, and made-to-order and bundles win that, both
through the Fulfilment Strategy interface of ADR-0014. ADR-0029 chose breadth without
knowing it was choosing against depth, because the other two proofs had not been written
down yet when it was.

Building the spine first is therefore not a detour from proving the surface. It is the
prerequisite for the two proofs that test the strategy interface at all.

## What is decided

- **The commerce spine is the next spec.** Scoped by ADR-0028's membership test — does
  omitting it make the rest of Core wrong? **In:** Cart, Line Item, Order with ADR-0009's
  snapshot, Adjustment, the Reservation interface with holds and an Inventory provider,
  Fulfilment as its own entity, and the `place-order` Workflow. **Out, each its own later
  spec:** Capacity and its calendar, ADR-0026's job queue, tax, shipping, Returns,
  Translations, customer groups, search, webhooks, and bundles.
- **The spine spec must itself run one of the blocked proofs**, and that is a condition
  rather than an aspiration — see below.
- **Content is next after it**, ahead of everything in the "out" list above except what the
  spine spec's own findings reorder.
- **`checkout` is not the name of anything.** `CONTEXT.md` already refuses the word under
  both Cart and Order. The Workflow is `place-order`; the moment is **Capture**.

## The condition, and what voids this ADR

The spine spec's acceptance includes **made-to-order at its thinnest, as a Plugin**: one
Plugin-registered Fulfilment Strategy answering ADR-0014's three questions, plus the
lead-time surcharge as an Adjustment through a replaced Step. Not the made-to-order feature
— the same discipline `@kobai/plugin-price-log` applies to the Workflow surface, pointed at
the strategy interface instead.

**Cut that, and this ADR's argument is void.** A spine spec that grows Core substantially
and runs none of the three named proofs has done exactly what ADR-0029 exists to prevent,
and would have no justification over building content first. If it has to be cut for size,
the correct response is to reopen this decision rather than to ship the spine and promise the
proof later — a proof deferred once is the failure mode ADR-0029 was written against.

One thing this ADR does **not** rest on, because it was checked and found to be weaker than
it looked: the claim that ADR-0013's open Workflow context has no buildable test until Line
Item exists. `docs/extension-points.md` records openness as **proven** — `context.metadata`
arrives verbatim and Core reads no key out of it, and the doc names "a lead time, a customer
tier, a contract" as what it carries. What is genuinely unbuildable is the lead-time
*surcharge*, because ADR-0022 makes it an Adjustment. ADR-0036's exhaustive unwinding is the
leg that stands unweakened: compensation ships and is unit-tested, and has no real case until
something can fail with money and stock already moved.

## Consequences

- **ADR-0029's release-gate clause is untouched and is not in question.** It is implemented:
  `tests/the-upgrade-gate.test.ts` runs on every commit. Only "content is built first" moves.
- **The spine spec is larger than the walking skeleton was**, and three exclusions are what
  keep it honest — Capacity, the job queue, and the tax/shipping/Returns/Translations group.
  Capacity is excluded on ADR-0012's own terms: it calls the calendar "the single largest
  addition", and a flat integer would contradict "a first-class domain concept with a
  calendar, not a derived number" in writing. The cost is that Reservation's "one interface,
  two providers" stays proven with one provider until the Capacity spec.
- **#72 becomes actionable now**, and its answer does not come from Media. Two named
  interfaces arrive from commerce instead — see
  [ADR-0052](./0052-a-fulfilment-strategy-is-dependency-substitution.md) and
  [ADR-0053](./0053-core-owns-the-payment-record-and-ships-no-provider.md).
- **#70 and #71 are sequenced behind content**, which is now behind the spine. They stay
  open and unassigned; nothing about them is decided here.
- **Two promises the spine spec establishes need recording where they land.** A Step may
  invoke another Workflow, so `place-order` prices its lines through `resolve-price` and a
  Project's `select-price` override applies at capture without being wired twice — ADR-0017
  does not speak to composition, and this is the first case of it. And `place-order` requires
  a **secret** API key, which is the first behavioural difference between the two kinds
  ADR-0020 introduced; today the split is cosmetic. Both are surface promises rather than
  implementation, so each needs its own record when built.
- **The upgrade gate grows with the reference Project.** With a Plugin-supplied Strategy and
  a Project-supplied `PaymentProvider` wired, the gate should also assert that an Order placed
  before a synthetic major reads back byte-identical after it — ADR-0009's immutability
  crossing a Core major for the first time. It still ships no codemod, because the spine
  breaks nothing.
