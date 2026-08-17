# The content platform is a first-party Plugin

Amends ADR-0016. Generic content types, blocks, pages, drafts, previews and localisation are
not deferred indefinitely and are not going into Core — they are a **first-party Plugin**,
shipped under kobai's name, part of 1.0 (ADR-0021) and not part of v1.

## Why not cut it

Q2 settled that kobai's wedge is the customisation model, and that *one model for commerce
and content* is the reason deep customisation is hard enough to be worth solving. Cutting
content entirely walks away from that thesis and from the project's original framing as an
e-commerce driven CMS.

## Why not in Core

It roughly doubles Core's surface, and every square inch of Core surface makes ADR-0003's
five stability promises more expensive to keep. Core staying small is what makes the promise
affordable.

## Why a Plugin is the right answer rather than a compromise

A content platform is the most demanding thing anyone will ever try to build on kobai's
extension surface. If it can be built as a Plugin, ADR-0003's promise is real and
demonstrated by the hardest available case. **If it cannot, the promise was never true**, and
that is something worth discovering deliberately rather than learning from a stranger's bug
report.

## Consequences

kobai *is* a commerce-driven CMS at 1.0 and is not one at v1, and both statements should be
made plainly. ADR-0016's naming correction stands for v1; its "deferred wholesale to v2"
framing is replaced by this decision.
