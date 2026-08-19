# The Admin's frame is conventional, because a Developer inherits it

> **Amended in the building (#175–#181).** Three things below are not quite what got built.
> The decisions all stand; these are the corrections, and they belong in front of the record
> rather than behind it.
>
> - **"the reason in a tooltip" was not enough**, and the gap was the announcement rather than
>   the picture. Base UI's `Tooltip` in this distribution gives its popup no `role="tooltip"`
>   and sets no `aria-describedby` on the trigger — checked in the installed package — so a
>   tooltip alone is a **visual** affordance, and a Merchant reading the screen with a screen
>   reader would have heard an unavailable control and no reason at all: precisely the thing
>   the decision exists to prevent. `src/components/action-button.tsx` therefore renders the
>   sentence a second time where only a screen reader finds it and describes the control by it,
>   whether the tooltip is open or not, and `tests/the-admin-in-a-browser.test.ts` asserts the
>   two halves separately.
> - **The list of deliberate departures has a home and a name**:
>   `reference/admin/src/components/ui/README.md`. It holds one change to what a component
>   *does* — `select.tsx` and `dropdown-menu.tsx` portal into a container the frame renders
>   inside `main`, because at `<body>` a popup is content outside every landmark and `axe-core`
>   reports it — and a table of Biome suppressions upstream is not written against. That one
>   change *is* held by a test, which this record did not expect: the browser seam audits
>   screens with an overlay open, so reverting it goes red.
> - **The narrowing moved out of `src/lib/kobai.ts`.** "`SessionRefusal` … is already narrowed
>   by hand" describes the Admin as it was: `src/lib/refusal.ts` now holds one `Record` per
>   closed family and a `narrowing()` built from it, so an added `reason` has no key and does
>   not compile.
>
> The last consequence below is discharged — #181 rewrote `AGENTS.md`'s Admin section, which is
> where each of these conventions now sits beside the assertion that holds it.

The Admin gets a **router, a query cache, a form library and a design system, all of them the
ones a React developer has already used** — react-router, TanStack Query, react-hook-form with
zod, and shadcn on Base UI. Nothing here is kobai's own invention, and that is the decision
rather than a shortcut around one.

[ADR-0033](./0033-the-admins-shape-a-vendored-vite-spa-at-a-path.md) put the Admin's source
*inside* the Project. [ADR-0010](./0010-the-admin-ships-in-one-container-and-gets-no-private-api.md)
gave it no private API, so it is also the standing proof that kobai's public surface is
complete. Both are already decided. What neither settled is the consequence that governs every
choice below: **a Developer owns these files outright and can never upgrade away from them.** A
dependency taken here is not a dependency kobai carries — it is one they carry, in a tree they
edit, with no `kobai-upgrade` codemod that can reach it (ADR-0035 gets `node:fs` and a
directory, and TypeScript 7 ships no compiler API).

So the question is not "what would we enjoy maintaining". It is "what will a stranger who
inherits 1,700 lines of somebody else's React be able to work on". That points one way.

## The stack is the one they have already seen

**Decided: react-router v7 with `basename="/admin-ui"`, TanStack Query, react-hook-form with
zod, shadcn on Base UI. No bespoke layer at any of the four.**

A hand-rolled data layer is exactly the thing a Developer cannot look up. It has no
documentation, no Stack Overflow answer and no second reader — and its bugs are indistinguishable
from kobai's. Every hour saved by writing a clever one is spent by somebody who did not write
it. The conventional library is worse in isolation and better in a tree somebody else owns,
which is the only place this code will ever live.

Three of the four were near-forced by what is already here:

- **The server half of routing already exists.** `reference/src/admin-assets.ts` falls back to
  `index.html` for every unmatched path under `/admin-ui/`, in as many words — "hand back the
  page and let it read the URL". Nothing reads it. The Admin's `app.tsx` says "there is
  deliberately no router" and holds the screen in `useState`, which was right for four screens
  and is not right for the roughly ten this Admin is about to have.
- **Base UI ships no `Form` component.** `components.json` says `"style": "base-nova"`, and the
  Base UI distribution's `/docs/components/base/form` is a *guide* rather than a component: it
  ships a `Field` family and lists react-hook-form first among the libraries to put behind it.
  So "which form library" was a question shadcn had already answered for this distribution, and
  taking its answer costs nothing.
- **`sonner` is `toast` here**, which is the kind of detail that is worth a line in a record
  because it will otherwise be rediscovered by somebody typing `shadcn add sonner` and getting
  a component under another name.

**Considered and rejected: TanStack Router**, whose type-safe params and search are genuinely
better DX. Its generated route tree would be a *fifth* generated-and-byte-compared artifact in
a repository that already holds `openapi.json`, `packages/client/src/schema.ts`,
`packages/create-kobai/template/` and every migration set — each of which has its own drift
test and its own regeneration command. The win is also thinner here than it looks: route params
are UUIDs `@kobai/client` already types, and the search state worth typing is the pagination
cursor, which [ADR-0064](./0064-list-pagination-is-a-cursor-and-the-page-number-is-given-up.md)
keeps deliberately opaque.

**Considered and rejected: no library at all** — hand-rolled routing over `history`, fetching in
`useEffect`, uncontrolled forms. It is what the Admin does today and it is honest at four
screens. It does not survive ten screens, cursor pagination, optimistic-free mutations with
invalidation, and a permission gate that has to refetch. The failure mode is not that it breaks;
it is that it becomes a small framework nobody documented.

## shadcn is composed, never replaced, and identity lives in the theme layer

**Decided: every primitive comes from `src/components/ui/`. App-level components compose them.
Density, colour and type are tuned through the tokens and `@theme inline` block in
`src/index.css`. Editing a vendored component is allowed where no token can reach, and is
written down at the edit.**

`shadcn add` writes the **upstream** version of each component. So a hand-tuned `Button` and a
`Table` added next month disagree on day one, and the disagreement grows with every component
added — which is the whole failure mode of "we customised our design system" arriving through a
door nobody thought was a door. Tuning the token layer instead reaches every component,
including the ones not added yet.

`src/components/problem.tsx` is the shape to copy: it is hand-written, it is app-level, and it
is built *on* `Alert`. That is composition. A `Problem` that drew its own bordered box would be
the thing this rules out.

**Dark mode ships.** A complete `.dark` token block sits in `src/index.css` and every vendored
component already carries `dark:` variants — and nothing in the source has ever put the class on
the document. A full palette wired to nothing is a broken promise in the first file a Developer
opens; system preference plus a persisted toggle is what it was always for.

**Considered and rejected: deleting the dark tokens** and committing to one look. It is the
honest alternative to leaving them unreachable, and it throws away work that is already done and
already correct.

**Considered and rejected: diffing `components/ui/` against upstream in the gate.** It is the
kind of drift check this repository reaches for by reflex, and here it would go red on every
shadcn release while telling us nothing we chose. What is kept instead is the cheap half: a list
of deliberate departures, in the spirit of `packages/create-kobai/src/adaptations.ts`, whose
value is that a departure has to be *written down* rather than that a machine agrees with it.

## A refusal is narrowed, never predicted

**Decided: where a refusal's `reason` is a closed set, the Admin narrows it exhaustively.
`messageOf` stays the documented fallback for a 500 and for the two families that keep `reason`
open. The Admin never re-implements a rule in order to predict a refusal.**

[ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md) records
that a new `reason` turns an exhaustive `switch` in a consumer into an incomplete one, and
frames it as a hazard owed a note in the release. Here it is the mechanism: the Admin is a
consumer that ships in the same repository as the surface, so **an addition to a closed family
reddens the Admin's build in the same commit**. That is worth having. `CatalogRefusal` is ten
reasons and is the busiest family the Admin touches; `SessionRefusal` is four and is already
narrowed by hand in `src/lib/kobai.ts`.

The two families that keep `reason` an **open string** — `PriceRefusal` and `PlaceOrderRefusal`,
open because closing them would close Extension Point 2 — take the fallback path *by design*.
Saying so here is the point: without it, the two look like the same convention applied
inconsistently.

**A refused deletion is attempted, not predicted.**
[ADR-0059](./0059-catalog-deletion-refuses-rather-than-cascading-or-releasing.md) makes catalog
deletion refuse with `last-variant` and `stock-is-reserved`, so a delete control that looks
available can still be turned back. The Admin confirms in an `AlertDialog`, submits, and on a
refusal **keeps the dialog open and renders the reason inside it** — rather than closing and
announcing the failure somewhere else, which puts the explanation where the Merchant no longer
is.

**Considered and rejected: checking client-side whether a delete would be refused**, and
disabling the control. It means the Admin holding an opinion about whether stock is reserved —
a rule that lives in Core, that Core may change, and that a Developer's Project may already have
changed underneath it through a replaced Step. The same argument forbids zod schemas here from
re-implementing a rule: they mirror `contract.ts`'s **structure** — presence, type, shape — and
every real rule arrives as a refusal.

**Considered and rejected: a central registry mapping every `reason` to copy.** One table is
easier to translate and easier to keep tidy. It also decouples the message from the route that
can produce it, so it goes stale silently, and it defeats the exhaustiveness above by making
every reason equally reachable from everywhere.

## The permission gate is an affordance, never a boundary

**Decided: sections a Role cannot read are hidden. Actions it cannot perform are rendered
`aria-disabled` with the reason in a tooltip. `requirePermission` is the enforcement; none of
this is.**

`GET /admin/session` has always returned `role.permissions`, and the Admin has always thrown it
away. Its own description says a deployment "may hold a permission this build of Core has never
heard of", so the set is **open**: this is `permissions.includes(…)`, never a union type and
never a `switch`.

**It is `aria-disabled` rather than `disabled`, and that is not a style preference.** A truly
`disabled` element fires no pointer events and takes no focus, so it can host no tooltip and
cannot be reached to be told why it is unavailable — the politeness the decision asks for is
unreachable through the obvious implementation of it. `aria-disabled` keeps the control
focusable and hoverable; its handler must then genuinely no-op, because unlike `disabled` it
does not prevent activation.

**The session query is treated as always stale**, refetched on window focus and on navigation,
because a Role edited under a live session otherwise leaves the Admin confidently wrong.

Writing "never a boundary" down is the load-bearing part. The next person to read a permission
check in this source will assume it is doing security work unless told otherwise, and would
then be right to wonder why it is cached at all.

**Considered and rejected: hiding every control the Role cannot use.** A Merchant with no
Products tab has no way to learn that Products exist to be asked for, and the UI ends up lying
about what kobai does. The split is deliberate: a whole section that would 403 on load is hidden
because an empty screen teaches nothing, and an individual action is shown-and-explained.

**Considered and rejected: no gate at all**, letting the 403 answer. Honest, cheap, and it
spends a round trip to tell somebody something the Admin already knew.

## The frame is tested in a browser, in the gate

**Decided: Playwright against a really-booted reference Project, inside `devbox run ci`, scoped
to the frame's own promises — deep-linking and refresh, session expiry and return, refusal
rendering, permission gating, list states. Plus `axe-core` on every screen those tests visit,
and explicit keyboard assertions.**

`reference/admin/` contains **no tests at all** today. What stands in for them is
`tests/admin-uses-only-the-public-api.test.ts`, which is a static ban on network primitives —
it proves the Admin cannot cheat, and nothing about whether it works.

[ADR-0044](./0044-the-cli-and-migrator-agreement-is-asserted-in-the-gate.md) settled where this
runs, for a different subject and with the same reasoning: a guardrail behind an opt-in step is
not a faster guardrail, it is an optional one. The gate already builds two images and stands a
registry up.

**The keyboard assertions are not padding.** Every decision in this record that accessibility
could sink is a keyboard one — the command palette, the `AlertDialog` that stays open on a
refusal, focus returning after a re-sign-in, and the `aria-disabled` controls above, which are
new and the least obvious of the four. `axe-core` sees contrast, labelling and roles; it sees
none of those.

**Considered and rejected: Vitest browser mode.** The suite is already Vitest and it would share
a runner. It is component-shaped, and what is being tested here is navigation, a cookie and a
real page lifecycle.

**Considered and rejected: driving a containerised Project**, the way
`tests/a-project-boots-from-its-own-compose-file.test.ts` does. It is the more faithful target
and too slow to run on every change.

## Consequences

- **This adds no Extension Point.** ADR-0003's five stay five: a router and a query cache are
  the Project's own dependencies in the Project's own source, which is what
  [ADR-0001](./0001-customisation-lives-in-a-project-not-a-fork.md) means by a Project. Nothing
  here is a surface a Plugin attaches to — that question is #71's, and it is deliberately still
  open.
- **#71 gets easier, and that was a reason for the order.** "Where may a Plugin put a component"
  cannot be answered against an Admin whose navigation is three entries in a `const`. A router,
  a sidebar and a command palette give the question real candidates. The palette in particular
  is chosen partly because it is the one navigation affordance a Plugin-contributed screen could
  use without renegotiating anything.
- **Every one of these dependencies lands in `devDependencies`**, like everything else in
  `reference/admin/package.json`: the bundle is inlined by `vite build`, so nothing here is
  required by the process at runtime.
- **All of it is regenerated into `packages/create-kobai/template/`** and byte-compared by
  `tests/create-kobai-matches-the-reference-project.test.ts`. None of it should need an entry in
  `adaptations.ts`; if something seems to, that is the signal it belongs in the reference Project
  instead.
- **The Admin's completeness becomes a claim about the API.** Under ADR-0010 the Admin may use
  only the public surface, so an operation a Merchant cannot perform is a finding about kobai
  rather than about the Admin. Six such findings were open when this was written and are the
  first half of the spec that follows — most sharply that **no route creates a Role**, which
  makes the gate above invisible in every deployment (one Role, `owner`, holding everything) and
  untestable through the only seam the Admin is allowed.
- **`AGENTS.md`'s Admin section is not updated by this record.** Its conventions are written
  with the test that holds each one, and none of these tests exist yet; the section is rewritten
  as the tickets land, not ahead of them.
