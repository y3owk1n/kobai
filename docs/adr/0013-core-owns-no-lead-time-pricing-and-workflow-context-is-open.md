# Core owns no lead-time pricing, and Workflow context is open

> **Test case re-anchored by [ADR-0029](./0029-the-reference-project-is-the-release-gate-and-content-is-built-first.md).**
> The standing rule below is unchanged. Its test case is now the reference Project and the
> content Plugin, not the printing store — which per ADR-0024 is no longer kobai's scoping
> device. Made-to-order remains a first-party Plugin capability.

Core does not know what a lead time is. Lead-time pricing is implemented entirely in the
Project as a replaced Step in the price-resolution Workflow, reading its input from Line
Item `metadata`. To make that possible, **a Workflow's context is open**: a Step may read
inputs Core has never heard of, carried on the Cart and Line Item.

## The standing rule

**If the printing use case cannot be built without changing Core, the extension surface is
wrong — fix the surface, do not add the feature.** ADR-0007 established that portfolio-scale
upgrade pain will not surface naturally with a single store. This is the compensating test,
and it is free: the first real customer exercises the flagship mechanism of ADR-0003 on day
one.

## Consequences

- The price-resolution Workflow's context **cannot be a closed typed struct**. If it were,
  this decision would be impossible and ADR-0003's flagship would fail its first real test.
  That openness is a deliberate cost paid in type safety at the context boundary.
- Should Core later need a first-class fulfilment-preference concept on Line Item, that is
  the acceptable fallback — but it must be reached by discovering that `metadata` genuinely
  is not enough, not by assuming it in advance.
