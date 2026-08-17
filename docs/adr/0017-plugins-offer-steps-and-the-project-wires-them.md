# Plugins offer Steps; the Project wires them

A Workflow Step is replaced through an **explicit config map in the Project** —
`steps: { 'resolve-price': myStep }`. A Plugin *offers* Steps; it never installs them. A
replacement must satisfy the original Step's input and output types. `before`/`after`
insertion exists as a separate, deliberately weaker mechanism that cannot alter the output
contract. And a Step may declare a **compensating action**, which Core runs in reverse when
a later Step fails.

## Why explicit over implicit registration

ADR-0003's stability promise is only credible if a Developer can open one file and see
exactly what has been overridden. With implicit registration — a Plugin calling
`registerStep` at load — an upgrade breaks and there is no way to tell which of eleven
Plugins caused it, and load order silently arbitrates conflicts. Explicit wiring costs a few
lines of config and buys a debuggable upgrade forever, which is the entire point of
ADR-0001.

Type-satisfying replacement is what makes swapping a Step *safe* rather than merely
possible, and is the main reason kobai is in TypeScript at all (ADR-0006).

## Why compensation in v1

Order capture spans payment, Capacity consumption (ADR-0012) and stock decrement. A partial
failure there is a real-world mismatch between what a Shopper was charged and what the Store
owes them. Compensation cannot be retrofitted cheaply — it means rewriting every Workflow
that exists by then — so the minimum version ships from the start.
