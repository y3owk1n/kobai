# kobai is not a CMS in v1

> **Amended by [ADR-0023](./0023-the-content-platform-is-a-first-party-plugin.md).** The
> naming correction below stands for v1. The content platform is not "deferred wholesale
> to v2" — it is a first-party Plugin, part of 1.0.

v1 ships commerce-native content only: product descriptions, Media, collections,
merchandising. That is **a catalog with rich fields, not a CMS**, and kobai will stop
describing itself as one until it is one. Generic pages, blocks, drafts, previews and
localisation are deferred wholesale to v2.

The "e-commerce driven CMS" idea remains the more interesting long-term product. It simply
is not what v1 ships, and claiming it now sets an expectation the software will not meet.
Saying so early costs nothing; saying it after someone has installed kobai expecting
Payload costs credibility.

## Consequences

`README.md` originally described kobai as "e-commerce backend plus cms" and has been
corrected to match. Any future content platform work should be checked against ADR-0004:
if it can be a Plugin owning its own tables, it should be.
