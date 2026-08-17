# Architecture Decision Records

Decisions made about kobai, why they were made, and which ones have since moved.

**Read the Status column before trusting a title.** Several titles were accurate when
written and are misleading now — ADR-0007 is not scoped by one real store, ADR-0016's "in
v1" no longer means anything, ADR-0018 has holds, and ADR-0022 does not rule out bundles.
Titles are never rewritten, because a decision that was reversed is part of the record.

## Start here

New to the project? These five carry the shape of everything else:

1. **[0001](./0001-customisation-lives-in-a-project-not-a-fork.md)** — customisation lives
   in a Project, not a fork. The founding decision.
2. **[0003](./0003-the-extension-surface-and-what-we-promise.md)** — the five Extension
   Points and what is promised. ADR-0001 moved the hard problem here.
3. **[0028](./0028-the-core-membership-rule.md)** — what belongs in Core. Settles most
   future arguments about scope.
4. **[0008](./0008-variants-are-sellable-and-prices-are-rows.md)** — the spine of the
   commerce model.
5. **[0024](./0024-one-release-target-v1-and-1-0-are-the-same-thing.md)** — one release
   target, and the three earlier decisions it voided.

## All records

| # | Decision | Status |
|---|---|---|
| [0001](./0001-customisation-lives-in-a-project-not-a-fork.md) | Customisation lives in a scaffolded Project, not a fork | Accepted |
| [0002](./0002-headless-the-storefront-is-out-of-scope.md) | Headless: kobai ships no storefront | Accepted |
| [0003](./0003-the-extension-surface-and-what-we-promise.md) | The extension surface, and what we promise stability on | Accepted |
| [0004](./0004-plugins-own-their-tables-core-tables-are-closed.md) | Plugins own their tables; Core's tables are closed | Accepted |
| [0005](./0005-single-tenant-with-first-class-channels-and-regions.md) | Single-tenant, with Channels and Regions first-class | Accepted |
| [0006](./0006-typescript-on-node-with-a-rest-openapi-contract.md) | TypeScript on Node, with a REST/OpenAPI contract | Accepted |
| [0007](./0007-a-project-not-a-business-scoped-by-one-real-store.md) | kobai is a project, not a business ~~scoped by one real store~~ | **Scope clause superseded by 0024.** Rest stands |
| [0008](./0008-variants-are-sellable-and-prices-are-rows.md) | Variants are the only sellable thing, and Prices are rows | Accepted |
| [0009](./0009-cart-and-order-are-separate-and-orders-snapshot.md) | Cart and Order are separate, and Orders snapshot everything | Accepted |
| [0010](./0010-the-admin-ships-in-one-container-and-gets-no-private-api.md) | The Admin ships in the Project's container and gets no private API | Accepted |
| [0011](./0011-postgres-and-drizzle.md) | Postgres, with Drizzle as the ORM | Accepted — **risk verified and closed** |
| [0012](./0012-capacity-constrained-availability-without-yield-pricing.md) | Capacity-constrained availability, without yield pricing | Accepted |
| [0013](./0013-core-owns-no-lead-time-pricing-and-workflow-context-is-open.md) | Core owns no lead-time pricing, and Workflow context is open | Accepted — test case re-anchored by 0029 |
| [0014](./0014-fulfilment-strategies-are-an-open-set-and-fulfilment-is-its-own-entity.md) | Fulfilment strategies are an open set, and Fulfilment is its own entity | Accepted |
| [0015](./0015-shopper-supplied-input-is-project-owned.md) | Shopper-supplied input is Project-owned, and is not Media | Accepted |
| [0016](./0016-kobai-is-not-a-cms-in-v1.md) | kobai is not a CMS ~~in v1~~ | **Amended by 0023.** Naming correction stands |
| [0017](./0017-plugins-offer-steps-and-the-project-wires-them.md) | Plugins offer Steps; the Project wires them | Accepted — unwinding edge settled by 0036 |
| [0018](./0018-one-reservation-model-implemented-without-holds.md) | One Reservation model, ~~implemented without holds~~ | **"No holds" superseded by 0027.** Interface and atomicity stand |
| [0019](./0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md) | Plugins are npm packages, and semver covers only the promised surface | Accepted |
| [0020](./0020-core-owns-merchant-auth-and-api-keys-but-not-shopper-credentials.md) | Core owns Merchant auth and API keys, but not Shopper credentials | **"One role" superseded by 0027.** Rest stands |
| [0021](./0021-v1-ships-one-real-order-1-0-is-the-envisioned-platform.md) | ~~v1 ships one real order; 1.0 is the envisioned platform~~ | **Superseded by 0024** |
| [0022](./0022-shapes-modelled-now-features-built-later.md) | Translations, Adjustments and Returns are modelled now; ~~Bundles are ruled out~~ | **Amended by 0024 and 0027.** Bundles are a Plugin |
| [0023](./0023-the-content-platform-is-a-first-party-plugin.md) | The content platform is a first-party Plugin | Accepted — amends 0016 |
| [0024](./0024-one-release-target-v1-and-1-0-are-the-same-thing.md) | One release target: "v1" and "1.0" are the same thing | Accepted — supersedes 0021 |
| [0025](./0025-one-core-package-with-first-party-plugins-as-the-split-points.md) | One Core package, with first-party Plugins as the split points | Accepted |
| [0026](./0026-postgres-backed-jobs-pluggable-storage-in-process-worker.md) | Postgres-backed jobs, pluggable storage, in-process worker | Accepted |
| [0027](./0027-holds-roles-and-bundles-re-decided-on-platform-terms.md) | Holds, roles and bundles, re-decided on platform terms | Accepted |
| [0028](./0028-the-core-membership-rule.md) | The Core membership rule | Accepted |
| [0029](./0029-the-reference-project-is-the-release-gate-and-content-is-built-first.md) | The reference Project is the release gate, and the content Plugin is built first | Accepted |
| [0030](./0030-generate-and-migrate-only-never-drizzle-kit-push.md) | `generate` and `migrate` only — never `drizzle-kit push` | Accepted |
| [0031](./0031-the-runtime-shape-devbox-a-pnpm-workspace-hono-and-one-gate.md) | The runtime shape: devbox, a pnpm workspace, Hono, and one gate command | Accepted |
| [0032](./0032-merchant-sessions-travel-in-an-httponly-cookie.md) | Merchant sessions travel in an httpOnly cookie, and SameSite is the CSRF answer | Accepted |
| [0033](./0033-the-admins-shape-a-vendored-vite-spa-at-a-path.md) | The Admin's shape: a vendored Vite SPA, built into the Project and served at a path | Accepted |
| [0034](./0034-kobai-is-published-and-the-reference-project-is-what-create-kobai-generates.md) | kobai's packages are published, and the reference Project is what `create-kobai` generates | Accepted |
| [0035](./0035-upgrading-is-a-command-kobai-ships.md) | Upgrading is a command kobai ships, carried by the version being upgraded to | Accepted |
| [0036](./0036-unwinding-is-exhaustive-and-never-replaces-what-stopped-the-run.md) | Unwinding is exhaustive, and a compensation that fails never replaces what stopped the run | Accepted — extends 0017 |
| [0037](./0037-updated-at-is-a-trigger-because-core-does-not-mediate-every-write.md) | `updated_at` advances by trigger, because Core does not mediate every write | Accepted |
| [0040](./0040-an-unrouted-path-is-a-refusal-and-the-gate-answers-before-it.md) | An unrouted path is a refusal like any other, and the gate answers before it | Accepted |

## Prototypes

Throwaway code kept as a primary source, on branches out of main.

- **`prototype/drizzle-multi-migration`** — settled ADR-0011's open risk and produced
  ADR-0030. Three packages generating, applying and evolving migrations independently
  against one Postgres. Run it with `devbox run prototype`; the verdict is in its
  `FINDINGS.md`.

## Open risks

- **[ADR-0024](./0024-one-release-target-v1-and-1-0-are-the-same-thing.md)** — the
  architecture ships without production validation. ADR-0029 is the deliberate substitute
  and only works if the reference Project is built early and upgraded honestly. The gate
  now exists (`tests/the-upgrade-gate.test.ts`, ADR-0035) and runs on every commit; what it
  cannot yet prove is that a codemod transforms anything, because kobai has broken nothing
  and so ships none.

_ADR-0011's Drizzle risk was closed by prototype — see above._

## Conventions

Sequential numbering, `NNNN-slug.md`. Format is in the
[`domain-modeling` skill](https://github.com/mattpocock/skills): one to three sentences of
what and why, with Considered Options and Consequences only where they earn their place.

An ADR is written when a decision is **hard to reverse**, **surprising without context**,
and **the result of a real trade-off**. If any of the three is missing, it isn't an ADR.

Superseded records are kept and their titles left intact. Add a blockquote note at the top
pointing at whatever replaced them, and update the Status column here.
