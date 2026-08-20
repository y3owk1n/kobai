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
5. **[0069](./0069-what-done-means-and-the-journey-that-says-so.md)** — what "done" means,
   as one Shopper journey, and the order the remaining specs run in.

## All records

| # | Decision | Status |
|---|---|---|
| [0001](./0001-customisation-lives-in-a-project-not-a-fork.md) | Customisation lives in a scaffolded Project, not a fork | Accepted |
| [0002](./0002-headless-the-storefront-is-out-of-scope.md) | Headless: kobai ships no storefront | **Two clauses amended by 0073.** Headline stands |
| [0003](./0003-the-extension-surface-and-what-we-promise.md) | The extension surface, and what we promise stability on | Accepted — **amended by 0047 and 0060** |
| [0004](./0004-plugins-own-their-tables-core-tables-are-closed.md) | Plugins own their tables; Core's tables are closed | Accepted |
| [0005](./0005-single-tenant-with-first-class-channels-and-regions.md) | Single-tenant, with Channels and Regions first-class | Accepted — **Region's definition narrowed by 0074** |
| [0006](./0006-typescript-on-node-with-a-rest-openapi-contract.md) | TypeScript on Node, with a REST/OpenAPI contract | Accepted |
| [0007](./0007-a-project-not-a-business-scoped-by-one-real-store.md) | kobai is a project, not a business ~~scoped by one real store~~ | **Scope clause superseded by 0024.** Rest stands |
| [0008](./0008-variants-are-sellable-and-prices-are-rows.md) | Variants are the only sellable thing, and Prices are rows | Accepted |
| [0009](./0009-cart-and-order-are-separate-and-orders-snapshot.md) | Cart and Order are separate, and Orders snapshot everything | Accepted |
| [0010](./0010-the-admin-ships-in-one-container-and-gets-no-private-api.md) | The Admin ships in the Project's container and gets no private API | Accepted |
| [0011](./0011-postgres-and-drizzle.md) | Postgres, with Drizzle as the ORM | Accepted — **risk verified and closed** |
| [0012](./0012-capacity-constrained-availability-without-yield-pricing.md) | Capacity-constrained availability, without yield pricing | Accepted |
| [0013](./0013-core-owns-no-lead-time-pricing-and-workflow-context-is-open.md) | Core owns no lead-time pricing, and Workflow context is open | Accepted — test case re-anchored by 0029 |
| [0014](./0014-fulfilment-strategies-are-an-open-set-and-fulfilment-is-its-own-entity.md) | Fulfilment strategies are an open set, and Fulfilment is its own entity | Accepted |
| [0015](./0015-shopper-supplied-input-is-project-owned.md) | Shopper-supplied input is Project-owned, and is not Media | Accepted — **clarified by 0072** |
| [0016](./0016-kobai-is-not-a-cms-in-v1.md) | kobai is not a CMS ~~in v1~~ | **Amended by 0023.** Naming correction stands |
| [0017](./0017-plugins-offer-steps-and-the-project-wires-them.md) | Plugins offer Steps; the Project wires them | Accepted — unwinding edge settled by 0036 |
| [0018](./0018-one-reservation-model-implemented-without-holds.md) | One Reservation model, ~~implemented without holds~~ | **"No holds" superseded by 0027.** Interface and atomicity stand |
| [0019](./0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md) | Plugins are npm packages, and semver covers only the promised surface | Accepted — **two exceptions: 0047, 0060** |
| [0020](./0020-core-owns-merchant-auth-and-api-keys-but-not-shopper-credentials.md) | Core owns Merchant auth and API keys, but not Shopper credentials | **"One role" superseded by 0027.** Rest stands — **extended by 0071** |
| [0021](./0021-v1-ships-one-real-order-1-0-is-the-envisioned-platform.md) | ~~v1 ships one real order; 1.0 is the envisioned platform~~ | **Superseded by 0024** |
| [0022](./0022-shapes-modelled-now-features-built-later.md) | Translations, Adjustments and Returns are modelled now; ~~Bundles are ruled out~~ | **Amended by 0024 and 0027.** Bundles are a Plugin |
| [0023](./0023-the-content-platform-is-a-first-party-plugin.md) | The content platform is a first-party Plugin | Accepted — amends 0016 |
| [0024](./0024-one-release-target-v1-and-1-0-are-the-same-thing.md) | One release target: "v1" and "1.0" are the same thing | **Scope clause superseded by 0069.** Its refusal to split into milestones stands |
| [0025](./0025-one-core-package-with-first-party-plugins-as-the-split-points.md) | One Core package, with first-party Plugins as the split points | Accepted |
| [0026](./0026-postgres-backed-jobs-pluggable-storage-in-process-worker.md) | Postgres-backed jobs, pluggable storage, in-process worker | Accepted |
| [0027](./0027-holds-roles-and-bundles-re-decided-on-platform-terms.md) | Holds, roles and bundles, re-decided on platform terms | Accepted |
| [0028](./0028-the-core-membership-rule.md) | The Core membership rule | Accepted |
| [0029](./0029-the-reference-project-is-the-release-gate-and-content-is-built-first.md) | The reference Project is the release gate, and ~~the content Plugin is built first~~ | **"Content first" amended by 0051.** Release gate stands |
| [0030](./0030-generate-and-migrate-only-never-drizzle-kit-push.md) | `generate` and `migrate` only — never `drizzle-kit push` | Accepted |
| [0031](./0031-the-runtime-shape-devbox-a-pnpm-workspace-hono-and-one-gate.md) | The runtime shape: ~~devbox~~, a pnpm workspace, Hono, and one gate command | **Toolchain and gate clauses superseded by 0083.** Workspace and Hono stand |
| [0032](./0032-merchant-sessions-travel-in-an-httponly-cookie.md) | Merchant sessions travel in an httpOnly cookie, and SameSite is the CSRF answer | Accepted |
| [0033](./0033-the-admins-shape-a-vendored-vite-spa-at-a-path.md) | The Admin's shape: a vendored Vite SPA, built into the Project and served at a path | Accepted — its CSS exclusion lifted by 0039 |
| [0034](./0034-kobai-is-published-and-the-reference-project-is-what-create-kobai-generates.md) | kobai's packages are published, and the reference Project is what `create-kobai` generates | Accepted |
| [0035](./0035-upgrading-is-a-command-kobai-ships.md) | Upgrading is a command kobai ships, carried by the version being upgraded to | Accepted |
| [0036](./0036-unwinding-is-exhaustive-and-never-replaces-what-stopped-the-run.md) | Unwinding is exhaustive, and a compensation that fails never replaces what stopped the run | Accepted — extends 0017 |
| [0037](./0037-updated-at-is-a-trigger-because-core-does-not-mediate-every-write.md) | `updated_at` advances by trigger, because Core does not mediate every write | Accepted |
| [0038](./0038-widening-a-populated-table-takes-three-migrations.md) | Widening a populated table takes three migrations, and the middle one is hand-written | Accepted |
| [0039](./0039-the-lint-gate-fails-on-every-finding.md) | The lint gate fails on every finding, and `biome.json` says so out loud | Accepted — sharpens 0031 |
| [0040](./0040-an-unrouted-path-is-a-refusal-and-the-gate-answers-before-it.md) | An unrouted path is a refusal like any other, and the gate answers before it | Accepted |
| [0041](./0041-the-first-merchant-is-seeded-at-boot.md) | The first Merchant is seeded at boot, and Core has no unauthenticated write path | Accepted — supersedes part of 0020 |
| 0042 | *Never used* — a number reserved and then given up | **Burned.** Never reassigned — see [Conventions](#conventions) |
| 0043 | *Never used* — a number reserved and then given up | **Burned.** Never reassigned — see [Conventions](#conventions) |
| [0044](./0044-the-cli-and-migrator-agreement-is-asserted-in-the-gate.md) | The CLI/migrator agreement is asserted in the gate, not behind an opt-in step | Accepted — enforces 0030 |
| [0045](./0045-sessions-expire-on-inactivity-under-an-absolute-cap.md) | Sessions expire on inactivity, under an absolute cap | **"The window is hardcoded" superseded by 0050.** Rest stands |
| [0046](./0046-the-postgres-credentials-belong-to-dot-env-too.md) | The Postgres credentials come from `.env`, ~~and devbox is where they are encoded~~ | **Superseded by 0084**, which keeps its one-source rule |
| [0047](./0047-the-test-harness-is-promised-surface.md) | The test harness is promised surface, and it is not a sixth Extension Point | Accepted |
| [0048](./0048-readiness-is-asked-over-the-transport-the-application-uses.md) | Readiness is asked over the transport the application uses, and waiting is not migrating | Accepted |
| [0049](./0049-migration-counts-are-derived-and-the-strength-moved-to-the-effect.md) | Migration counts are derived, and the strength moved to the effect | Accepted |
| [0050](./0050-the-idle-window-is-a-projects-the-cap-is-cores.md) | The idle window is a Project's, the absolute cap is Core's | Accepted — supersedes part of 0045 |
| [0051](./0051-the-commerce-spine-comes-before-the-content-plugin.md) | The commerce spine comes before the content Plugin | **Ordering superseded by 0069.** Its rule — the hardest proof earliest — stands |
| [0052](./0052-a-fulfilment-strategy-is-dependency-substitution.md) | A Fulfilment Strategy is dependency substitution, not a sixth Extension Point | Accepted — reconciles 0014 with 0003 |
| [0053](./0053-core-owns-the-payment-record-and-ships-no-provider.md) | Core owns the Payment record and ships no provider | Accepted — **completed by 0070** for redirect methods |
| [0054](./0054-a-step-may-invoke-another-workflow.md) | A Step may invoke another Workflow, and the deployment's declaration is the one that runs | Accepted — extends 0017 |
| [0055](./0055-placing-an-order-requires-a-secret-key.md) | Placing an Order requires a secret key, and that is a gate rather than a check | Accepted — extends 0020; **0071 keeps it out of the Admin** |
| [0056](./0056-a-payment-records-whether-the-money-arrived.md) | A Payment records whether the money arrived, and that is a record rather than a status | Accepted — completes 0053; **0070 reaches its open door without using it** |
| [0057](./0057-the-reservation-sweeper-is-an-interval-not-a-job.md) | The Reservation sweeper is an interval, not a job | Accepted — amends part of 0026 |
| [0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md) | A promised surface may be broken until the first release, and a compile error is the notice | Accepted — its first rule expires at the first publish |
| [0059](./0059-catalog-deletion-refuses-rather-than-cascading-or-releasing.md) | Catalog deletion refuses rather than cascading or releasing | Accepted — completes 0008; its open question settled by **0062** |
| [0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md) | The HTTP surface is promised, and a refusal's `reason` is part of it | Accepted — **amends 0019 and 0003** |
| [0061](./0061-what-the-first-publish-owes.md) | What the first publish owes is one list, and the next obligation joins it | Accepted — **a live list until the first publish** |
| [0062](./0062-a-variant-is-corrected-in-place-and-a-price-is-superseded.md) | A Variant is corrected in place, and a Price is superseded | Accepted — the other half of 0059 |
| [0063](./0063-the-admins-frame-is-conventional-because-a-developer-inherits-it.md) | The Admin's frame is conventional, because a Developer inherits it | Accepted — extends 0010 and 0033; **three corrections amended in from the building** |
| [0064](./0064-list-pagination-is-a-cursor-and-the-page-number-is-given-up.md) | List pagination is a cursor, and the page number is given up | **"Every list route" bounded by 0067**, and **"the Admin gets next/prev" amended in from the building**. A list over a table pages; rest stands |
| [0065](./0065-a-stores-default-currency-is-fixed.md) | A Store's default currency is fixed | Accepted — **its argument narrowed by 0074**, which answers 0008's question. The refusal stands |
| [0066](./0066-administering-access-is-one-permission-and-the-last-administrator-cannot-be-removed.md) | Administering access is one Permission, and the last administrator cannot be removed | Accepted — makes 0027 reachable; applies 0059's shape to a Role |
| [0067](./0067-a-set-the-deployment-declares-is-not-a-list-route.md) | A set the deployment declares is not a list route | Accepted — bounds 0064; answers 0010's finding against 0014 |
| [0068](./0068-gitignore-is-the-one-statement-of-what-a-checkout-generates.md) | `.gitignore` is the one statement of what a checkout generates | Accepted — completes 0039; binds `biome.json` and every `.dockerignore` to it |
| [0069](./0069-what-done-means-and-the-journey-that-says-so.md) | What "done" means, and the journey that says so | Accepted — **supersedes 0024's scope clause; reorders 0051** |
| [0070](./0070-a-payment-the-shopper-completes-at-their-bank.md) | A payment the Shopper completes at their bank | Accepted — completes 0053 and 0056 |
| [0071](./0071-a-cart-is-listable-and-a-merchant-may-place-an-order-on-behalf.md) | A Cart is listable, and a Merchant may place an Order on behalf | Accepted — extends 0020 and 0055 |
| [0072](./0072-an-address-is-cores-and-validating-one-is-not.md) | An Address is Core's, and validating one is not | Accepted — clarifies 0015 |
| [0073](./0073-the-checkout-is-hosted-optional-and-not-vendored.md) | The Checkout is hosted, optional, and not vendored | Accepted — **amends 0002**; deliberately not 0033's shape |
| [0074](./0074-currencies-are-enabled-by-the-store-and-selected-by-the-region.md) | Currencies are enabled by the Store and selected by the Region | Accepted — completes 0008; **narrows 0005 and 0065's argument** |
| [0075](./0075-the-hold-window-is-a-projects-and-core-keeps-no-ceiling.md) | The hold window is a Project's, and Core keeps no ceiling over it | Accepted — 0050's shape, **without its cap**; carries out 0070 |
| [0076](./0076-a-merchants-role-is-corrected-in-place.md) | A Merchant's Role is corrected in place, and a Merchant is still never removed | Accepted — 0062's shape on one more table; **discharges 0066's note** and makes 0059's repair reachable |
| [0077](./0077-a-quote-is-a-route-not-a-total-on-the-cart.md) | A quote is a route, not a total on the Cart | Accepted — closes a hole in 0070; **leaves 0009 untouched** and says why |
| [0078](./0078-media-bytes-come-from-the-storage-and-kobais-own-route-is-open.md) | Media bytes come from the storage, and kobai's own byte route is open | Accepted — Core ships an implementation here for a reason **0053 does not have**, and 0053 is untouched |
| [0079](./0079-the-admin-takes-a-second-audience-and-it-is-one-app.md) | The Admin takes a second audience, and it is one app | Accepted — extends 0010, 0033 and 0063; **amends `CONTEXT.md`'s Admin** |
| [0080](./0080-a-deployment-describes-itself.md) | A deployment describes itself | Accepted — **0010's second finding**, after 0067; bounded by 0067 and gated by a new Permission |
| [0081](./0081-the-playground-attaches-its-credential-and-omits-the-ambient-one.md) | The Playground attaches its credential, and omits the ambient one | Accepted — extends 0032 and 0055; **defers a bearer credential for `/admin`** |
| [0082](./0082-a-detached-media-is-still-the-stores.md) | A detached Media is still the Store's, and kobai deletes no bytes | Accepted — 0059's rule reached one table out, held by a `restrict`; **declines 0078's `remove`** and says what would settle it |
| [0083](./0083-the-commands-live-in-package-json-and-devbox-is-not-required.md) | The commands live in `package.json`, and devbox is not required | Accepted — **supersedes two of 0031's four clauses**; moves 0030's and 0039's guardrails |
| [0084](./0084-a-linked-worktree-seeds-its-own-dot-env.md) | A linked worktree seeds its own `.env` | Accepted — **supersedes 0046**, whose one-source rule it keeps; completes 0083 |
| [0085](./0085-core-emits-the-project-wires-a-subscriber-and-delivery-is-in-process.md) | Core emits, the Project wires a subscriber, and delivery is in-process | Accepted — fills 0003's fourth Extension Point; applies 0017 and 0036; **declines 0026's queue**, closing half of 0069's risk |

## Prototypes

Throwaway code kept as a primary source, on branches out of main.

- **`prototype/drizzle-multi-migration`** — settled ADR-0011's open risk and produced
  ADR-0030. Three packages generating, applying and evolving migrations independently
  against one Postgres. Check the branch out and follow its `FINDINGS.md`, which is where
  the verdict is; there has never been a script in this repository that runs it.

## Open risks

- **[ADR-0024](./0024-one-release-target-v1-and-1-0-are-the-same-thing.md)** — the
  architecture ships without production validation. ADR-0029 is the deliberate substitute
  and only works if the reference Project is built early and upgraded honestly. The gate
  now exists (`tests/the-upgrade-gate.test.ts`, ADR-0035) and runs on every commit; what it
  cannot yet prove is that a codemod transforms anything, because kobai still ships none. It
  has broken a promised surface once —
  [ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md) — and that
  break deliberately carries no codemod, because the Project's own compiler is the notice.
  The first break a codemod *can* migrate is what will close this.

- **[ADR-0069](./0069-what-done-means-and-the-journey-that-says-so.md)** — two things it
  defers may not stay deferred. **Capacity is out**, which leaves ADR-0018 promising "one
  interface, two providers" while only one will exist at the first release; **that wording is
  owed a correction**, and correcting prose is cheaper than shipping a calendar to make an old
  sentence true. Its other half — that **ADR-0026's job queue may arrive unplanned** — is now
  closed by
  [ADR-0085](./0085-core-emits-the-project-wires-a-subscriber-and-delivery-is-in-process.md),
  which decides events are in-process and not durable: the queue is not pulled into the
  Order-after-Capture spec, and the sweeper debt ADR-0057 owes it stays where it is. What
  would reopen it is written down there.

_ADR-0051's risk — that the spine would grow Core while running none of the three named proofs
— was discharged: `@kobai/plugin-made-to-order` ships, the reference Project wires it, and the
upgrade gate crosses a Core major with it. Its ordering is now ADR-0069's._

_ADR-0011's Drizzle risk was closed by prototype — see above._

## Conventions

Sequential numbering, `NNNN-slug.md`. Format is in the
[`domain-modeling` skill](https://github.com/mattpocock/skills): one to three sentences of
what and why, with Considered Options and Consequences only where they earn their place.

An ADR is written when a decision is **hard to reverse**, **surprising without context**,
and **the result of a real trade-off**. If any of the three is missing, it isn't an ADR.

Superseded records are kept and their titles left intact. Add a blockquote note at the top
pointing at whatever replaced them, and update the Status column here.

**A burned number gets a row, not a gap.** A number reserved by a ticket that then turns out
not to need an ADR is given up, and it is never handed to a later decision: a number that once
meant something else is a footgun for every commit message, doc comment and issue that cites
it, and those citations are the whole reason a record has a number at all. Giving one up means
writing it into the table above as an unused row, because the alternative is a sequence that
jumps and cannot say why.

That is what 0042 and 0043 are (#147). They were reserved by #61 and #19 — the other two of a
round of four concurrent tickets, whose other halves produced 0041 (#25) and 0044 (#46). #61
gave `pnpm run up` a port derived from the checkout, and #19 moved a hand-rolled
`information_schema` query onto `inspectSchema`; both landed as ordinary changes that met no
part of the three-way test above, so neither number was ever spent. Which of the two held
which is the one thing nobody wrote down, so neither row above claims it.

**Nothing was lost, and the rule exists because the record still read as though something
had been.** No file named `0042*` or `0043*` has ever existed here — across every reachable
commit and every unreachable one `git fsck` can still find, the ADR paths go 0041 to 0044 —
and nothing in the repository cites either number. The reservation was even explained twice,
in the commit messages behind PR #89 and PR #97, and both were squash-merged, which keeps the
subject and drops the body; the account naming the two tickets is in PR #89's description.
None of that is anywhere a reader of this file would look, which is the whole point: neither
a commit message nor a pull request is the index.
