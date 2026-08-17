# kobai is a project, not a business, scoped by one real store

> **Scope clause superseded by [ADR-0024](./0024-one-release-target-v1-and-1-0-are-the-same-thing.md)**
> (via ADR-0021, itself superseded). kobai has one release target — the platform in full —
> and is **not** scoped by one real store. The title of this ADR is therefore misleading;
> its remaining clauses (project not business, MIT, no paid tier, agencies as the target
> segment) stand.

kobai is MIT-licensed and will carry no paywall, no open-core split, and no hosted
offering. It is built by one person as infrastructure for a business built *around* it —
a single brand store the author operates, which is kobai's first and, for now, only
customer.

This is recorded because it is invisible in the code and answers two questions a future
reader will have: why there is no enterprise edition, and why v1 is as small as it is.

## Consequences

- **v1 contains what one real store needs to take and fulfil a real order, and nothing
  else.** Everything else is a Plugin or a later version. This is the project's primary
  defence against the unbounded scope that kills greenfield platforms.
- No architectural seam exists to position a future paywall. Open-core boundaries drawn
  early distort design, because you start building toward where the paywall goes instead
  of where the seam goes.
- The target segment is agencies (deep customisation, many stores) but the first customer
  is a single brand. Portfolio-scale upgrade cost — the pain ADR-0001 exists to prevent —
  will therefore not surface through real use, and must be tested deliberately by
  upgrading a Project across a Core major version on purpose.
