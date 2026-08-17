# A Fulfilment Strategy is dependency substitution, not a sixth Extension Point

ADR-0014 says a Variant points at a named **Fulfilment Strategy** "registered by Core or by a
Plugin", answering does-this-ship, does-it-consume-stock, does-it-have-a-lead-time. That
reads like a registry, and a registry is a surface. It is **not** a sixth Extension Point: it
is Extension Point 3, dependency substitution behind a named interface, reached through
Extension Point 1, configuration — the same answer ADR-0026 reached for Media storage.

## Why this needed deciding at all

ADR-0003's list of five is closed, and `docs/extension-points.md` says growing it "is a
one-way door". Yet the word "fulfilment" occurs **once** in that entire document, in a list of
things Workflow Steps are good for. So ADR-0014 has been promising a registration surface that
the closed list does not contain, and nothing had reconciled the two. Left alone, the spine
spec would have settled it by accident — whichever shape the implementation took would have
become the promise, which is how a sixth Extension Point gets added without anybody deciding
to add one.

The bar is set by the one time this test has already been run: "pluggable Media storage looked
like it needed a sixth mechanism and turned out to be dependency substitution, which was
already number three. That is the standard a sixth has to fail before it earns a place." A
Fulfilment Strategy fails it in exactly the same way. Core needs a collaborator that answers
three questions about a Variant; it names an interface and takes yours. That is the `Logger`
shape, and `Logger` is already number three.

## What is decided

- **A Fulfilment Strategy is a named interface Core calls for answers.** Core ships
  `physical` and `digital`; a Plugin *offers* one and the Project *wires* it in
  `kobai.config.ts`, per ADR-0017. Nothing registers itself by being installed.
- **The list of Extension Points stays five.** ADR-0003 is unamended.
- **Made-to-order stays a Plugin** (ADR-0014), and is the first strategy from outside Core.

## Consequences

- **This is what makes #72 answerable, and the answer is not Media.** The complaint there is
  precise: `Logger` has exactly one interface with two implementations, "both of those
  implementations are still Core's own, so what is proven is that the seam works, not yet that
  anybody has put something of their own through it." A Plugin-supplied Fulfilment Strategy is
  a second interface with an implementation from outside Core, wired by the Project and
  observably different — which is the standard #72 sets for the mechanism becoming credible.
- **`Logger`'s shape is now precedent.** ADR-0019 puts an interface's shape under semver
  forever once shipped, and this is the second interface to copy it. #72 already flags that
  `Logger` "deserves a deliberate look before more interfaces copy it", and this ADR is the
  moment that look is owed.
- **A closed set is still what ADR-0014 rules out.** `requires_shipping` and
  `tracks_inventory` remain questions answered by a strategy rather than flags on a Variant,
  which is the whole reason this is an interface and not an enum.
