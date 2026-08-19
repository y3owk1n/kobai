# The Admin

The vendored Admin at `reference/admin/` — the frame a Developer inherits, what may be composed and what may not, and the browser seam that holds it. **Read this before editing anything under `reference/admin/`.**

Part of [`AGENTS.md`](../../AGENTS.md), which is the source of truth and says when to read this.
## The Admin

**The Admin is vendored source, not a dependency** (ADR-0010, ADR-0033). It lives at
`reference/admin/` — React on Vite, Tailwind v4, shadcn/ui on **Base UI** — and every
component under `src/components/ui/` is an ordinary file in this repository because
that is how shadcn works: `shadcn add` copies source in. Edit them.

**The frame is conventional, because a Developer inherits it** (ADR-0063). react-router v7,
TanStack Query with **no optimistic updates**, react-hook-form with zod checking **structure
only**, and shadcn on Base UI. Not one of the four is kobai's own invention, and that is the
decision rather than a shortcut around one: a dependency taken here
is one the **Developer** carries, in a tree they own outright and can never upgrade away from —
`kobai-upgrade` gets `node:fs` and a directory, and TypeScript 7 ships no compiler API
(ADR-0035), so **no codemod will ever reach this source**. The bar is therefore not what kobai
would enjoy maintaining, it is what a stranger who has inherited somebody else's React can look
up. So **do not put a bespoke layer at any of the four** — and the thing to know before
reaching for the obvious upgrade is that TanStack Router was weighed and refused: its generated
route tree would be a *fifth* generated-and-byte-compared artifact beside `openapi.json`,
`packages/client/src/schema.ts`, `packages/create-kobai/template/` and every migration set, to
type route params `@kobai/client` already types and a search parameter ADR-0064 keeps opaque on
purpose.

**Where the Admin is served is said once**, and the router does not say it: `app.tsx` takes its
`basename` from `import.meta.env.BASE_URL`, so `vite.config.ts`'s `base` is the single
statement of that path — and it has to agree with `ADMIN_PATH` in
`reference/src/admin-assets.ts`, which is the server half. Two literals in two packages is
exactly the shape that goes wrong quietly, so `reference/src/app.test.ts` reads `base` back out
of the config file and holds them equal. Nothing else about the stack has a test behind it, and
that is honest rather than a gap: what holds a choice of library is the record that took it.

**Base UI is not Radix, and two of the names differ.** `components.json` says
`"style": "base-nova"`, so `shadcn add` fetches the Base UI distribution, where two of the names
a Radix habit reaches for are not the names. There is **no `Form` component** — there is a
`Field` family, and the distribution's own guide puts react-hook-form behind it, which is why
`components/form-field.tsx` composes `Field` rather than wrapping a `Form` that does not exist.
And **`sonner` is `toast`**: `shadcn add sonner` gets you the component under the other name.
Everything else the frame needs is there under the name you expect — and this paragraph exists
because both of these are otherwise rediscovered once per contributor, at the CLI.

**shadcn is composed, never replaced, and identity lives in the theme layer** (ADR-0063). Every
visual primitive comes from `src/components/ui/`; an app-level component composes them —
`components/problem.tsx` is built *on* `Alert` and `components/pager.tsx` on `Pagination`, and a
`Problem` that drew its own bordered box would be the thing this rules out. Density, colour and
type are tuned in `src/index.css`'s tokens and its `@theme inline` block, because `shadcn add`
writes the **upstream** version of whatever it is given: a hand-tuned `Button` and a `Table`
added next month disagree on the day the second one arrives, while a value changed in the token
layer reaches every component in the directory *including the ones not added yet*. That is the
whole failure mode of "we customised our design system", arriving through a door nobody thought
was a door.

**An edit no token can reach is allowed, and its price is being written down twice**: a
`CHANGED FROM UPSTREAM` comment at the line, and an entry in
**`reference/admin/src/components/ui/README.md`**, which is where that list lives. There is
deliberately **no test diffing that directory against upstream** — it would go red on every
shadcn release while saying nothing whatever about what we chose — so the list is the cheap half
of that check, and its entire value is that a departure had to be typed out by somebody. Today
it holds three changes to what a component *does* — `select.tsx` and `dropdown-menu.tsx` portal
into the frame's container rather than `<body>`; `sidebar.tsx` spreads the props it is given
onto an element in its narrow branch rather than onto a dialog root that renders none (#193);
and neither of `sidebar.tsx`'s two button recipes takes pointer events away from an
`aria-disabled` control any more (#199) — and a table of Biome suppressions upstream is not
written against. The browser seam holds the first with an audit and the second by asking for the
landmark by name; the third is held by
`tests/an-unavailable-control-can-still-be-reached.test.ts`, because nothing a browser can be
asked would have seen it — see below.

**It also holds one thing that has deliberately *not* been changed, and it is the one to know
before reaching for a tooltip.** Base UI's tooltip at the version this Admin pins gives its
popup no `role="tooltip"` and sets no `aria-describedby` on the trigger, so it is a **visual**
affordance and a screen reader is told none of it. **Never put information only in a tooltip**:
`components/action-button.tsx` is the shape to copy, rendering the sentence again in an
`sr-only` span and describing the control by that. Fixing `ui/tooltip.tsx` was weighed and
refused (#199) — Base UI unmounts the popup when it is closed, so an `aria-describedby` would
resolve to nothing for exactly the reader who never opens the tooltip, and the workaround would
have to stay anyway.

Add a component with

```sh
devbox run -- pnpm --filter kobai-reference-admin exec pnpm dlx shadcn@latest add <name>
```

and move whatever it writes into `dependencies` over to `devDependencies` — the whole frontend
toolchain is bundled at build time, so none of it belongs in the shipped image. That README has
the rest of it: what to run afterwards, what to answer when the CLI offers to overwrite a
component that is already here, and the list itself.

**One process serves both.** `reference/src/app.ts` asks one question — is this path the
Admin's? — and hands everything else to `kobai.fetch` untouched. The Admin is at
`/admin-ui`, deliberately **outside** `/admin`: the session cookie's default-path is the
admin surface's directory (ADR-0032), and a cookie path matches only at a `/` boundary, so no
asset request carries the credential. Beware that `/admin` *is* a bare string prefix of
`/admin-ui` — match on the path boundary, never on `startsWith` alone.

**There is no CORS configuration in this repository, and adding one is a wrong turn.** One
origin is what ADR-0010 spends the single container on. The dev loop keeps it: `devbox run
admin:dev` is a Vite server that **proxies** `/admin`, `/store` and `/health` to the Project,
so the browser still sees one origin while editing.

**The Admin may use only the public API, through `@kobai/client`.** No raw `fetch`, no
`@kobai/core` import, and no route that exists for its benefit — if the Admin needs something
the API cannot do, that is a finding about the API (ADR-0010).
`tests/admin-uses-only-the-public-api.test.ts` fails the build on any network primitive in
the Admin's source and on any kobai path `openapi.json` does not carry. That is a static ban:
it proves the Admin cannot cheat and nothing whatever about whether it works. What proves the
second is the browser seam below.

**The Admin is tested in a real browser, in the gate** (ADR-0063, #175).
`tests/the-admin-in-a-browser.test.ts` drives Chromium against a really-booted reference
Project — `node dist/src/server.js` against a throwaway database, on a port the OS hands out —
and `tests/support/admin-browser.ts` is the harness, which says in its own header how to add a
case. `devbox run browsers` downloads the browser and `devbox run ci` and `devbox run test`
both run that themselves, for ADR-0044's reason: a guardrail behind an opt-in step is not a
faster guardrail, it is an optional one. Seven things about it are decisions rather than
implementation:

- **It asserts the frame's promises and never screen behaviour.** Deep-linking, refresh,
  browser back and forward, a session running out mid-use and the Merchant landing back where
  they were, a refusal rendering where it was attempted, skeleton, spinner and empty states,
  and what a narrow Role is offered — which sections, which actions, and that an unavailable
  one really does nothing (`seam.merchantOnARole`, `seam.signedInAs`). **A case that a request-level test could have asked belongs there instead**, which
  is where screen behaviour has always been asserted. The catalog cases (#179) are the same
  test applied to a busier screen: a **refused** deletion staying in its dialog, a delete
  control offered although the deletion is about to be refused, and — the one nothing else in
  this repository can ask — **which requests the Admin made and in what order**, which is how
  "superseding a Price adds the new one before removing the old" becomes an assertion rather
  than a claim in a comment.
- **A visible overlay is not the same as a settled one, and an assertion about a dialog goes
  after the audit.** A closing dialog *fades*, so it stays mounted and visible for the length of
  `data-closed:animate-out` — long enough that "the dialog is still open" passed against a
  `ConfirmDelete` that closed on every answer. `auditAccessibility` waits for every animation
  that will end to have ended, so putting it first is what makes the line after it mean
  something. **Assert on a dialog's presence only once something has waited for the animation.**
- **`axe-core` runs on every screen a case visits and any violation fails the build.** It is a
  call per screen rather than per case, so a case that navigates twice audits twice — and an
  **overlay is a screen**, so a case that opens the command palette audits it open, which is a
  different surface from the page under it. The audit waits for every animation that will end to
  have ended, because it measures pixels: half way through the palette's fade its group heading
  read 4.1:1 against a threshold of 4.5, on colours that pass everywhere once they have settled.
  An animation that repeats for ever is skipped rather than waited on, or the boot gate — whose
  only content is a `Spinner` — would hang instead of being audited.
- **The keyboard assertions are not padding, because a scanner sees none of them.** Reaching a
  control is `tabTo`/`keyboardTo`, which press a key until the control has focus and fail
  naming where the keyboard got to instead — `Tab` walks the page, `ArrowDown` walks an open
  menu. Focus after a re-sign-in and the `aria-disabled` controls that stay focusable so they
  can host the explanation of why they are unavailable (#178) are keyboard decisions, and all
  arrive here. **An unavailable control is asserted twice**, because the tooltip and the
  announcement are two different things: what a mouse sees is the popup, and what a screen
  reader is told is the `aria-describedby` the component wires itself, since Base UI's tooltip
  gives its popup no `role="tooltip"` and associates it with nothing. **The command palette is a combobox over a listbox**, so the arrow keys move the
  *selection* while the keyboard stays in the input — its list is asserted on `aria-selected`,
  which is what a screen reader announces, `tabTo` is for reaching its button, and where the
  keyboard ends up after it closes is asked with `isFocused`.
- **Arrange through the API and open a window per case.** Every case gets its own browser
  context — its own cookie jar, its own `localStorage` — so nothing one case leaves behind is
  reachable from another; the *catalog* is shared, because a boot per case is not affordable,
  so a case names its own titles and calls `emptyTheCatalog` when an empty list is its subject.
  Time is passed by winding `core_session.expires_at` back, never by waiting.
- **A window is 1280×720 unless a case names another, and the seam proves what it visits at the
  viewport it visits it** (#193). That is worth knowing about every assertion the file makes and
  not only about the one that found it out: #175 built this seam, caught five accessibility faults
  with it on their first run, and could not catch a sixth — `Sidebar` spreads `{...props}` onto a
  different thing in each of its three branches, and below `md` onto a dialog *root*, so the
  landmark `app-layout.tsx` passes reached no element and the Admin had no sidebar landmark on a
  phone at all. A case wanting that layout passes `A_NARROW_WINDOW`. **Which cases run twice is a
  decision, and the answer is "the sidebar's"**: `hooks/use-mobile.ts` is the only thing here that
  renders a different *document*, and `components/ui/sidebar.tsx` is the only file that reads it —
  everything else narrows in CSS, which changes a layout, and axe measures the document. Running
  the whole file at two widths would double what the maintainer was told it costs, to re-prove an
  identical DOM. **A third narrow case is earned by something else branching on that hook**, not
  by a screen looking different when it is narrow.
- **The browser is Chromium's headless shell**, which is what `--only-shell` downloads and what
  `channel: "chromium-headless-shell"` launches — since Playwright 1.49 a bare `headless: true`
  asks for the full browser, which is deliberately not downloaded. The flag and the channel are
  one decision in two files and the seam's first case holds them together.

One thing in the Admin looks like an oversight and is not: `Pager`'s dead Next/Previous use
real `disabled` rather than `aria-disabled`, deliberately, because there is no explanation to
host on one. The same goes for every control dead only while a request is in flight.

**Every screen is on the frame, and a screen takes no props** (#176). A screen is a component a
route names and nothing else: it reads its identifier from the router (`lib/route.ts`'s
`useRouteId`, which is where react-router's `string | undefined` is settled once), its client
from `useKobaiClient`, and its data through TanStack Query. `app.tsx` therefore holds paths and
components, with no adapter in between — the four wrappers that pulled a client and a
back-navigation callback out of context and handed them down as props are gone, and a new one
would be the pre-frame shape coming back. **A form field is
`components/form-field.tsx`** — a label, an input and the schema's message, in one place because
the invalid state has to be set twice (`Field` reads `data-invalid`, the `Input` announces
`aria-invalid`) and an `id` is unique to the document rather than to the form it is in. The rest
are conventions rather than one screen's choice, and are deliberately not numbered here — the
list grows with every screen, and a count in prose is the tax ADR-0049 removed from the tests:

- **Every list pages through the cursor, with the cursor in the URL** — Products, Orders, Carts
  and API keys alike, through the one `components/pager.tsx`. A list route that took no page would
  be a screen on which the older half of a Store cannot be reached, and API keys is the
  non-obvious one: the storefront price preview mints a publishable key per browser session
  that has none, so they accumulate without anybody minting one on purpose.
  **A list that narrows keeps its narrowing across a page** (#228). The pager moves the cursor
  and carries the rest of the query string over untouched, because one that rebuilt the search
  out of the cursor alone answers the second page of the *whole* table — which looks exactly
  like paging working, and is a different question being answered. Carts is the list that has a
  narrowing today (`?state=live|expired|spent`, ADR-0071), and the filter is a set of **links**
  rather than a control with a value, for the reason the cursor is in the URL at all: each state
  is an address a Merchant can send and a refresh lands on. Choosing one **drops** the cursor,
  since a cursor locates a page of the list that issued it.
- **A closed refusal family is narrowed, never matched on prose.** `lib/refusal.ts` holds one
  `Record` per family keyed by that family's own union and a `narrowing()` built from it, so a
  `reason` added in Core has no key, does not compile, and reddens the Admin in the same commit
  (ADR-0063). The screen's `switch` ends in `const unreached: never`, which is what holds the
  arms complete. `PriceRefusal` and `PlaceOrderRefusal` keep `reason` open and take `messageOf`
  **by design** — closing them would close Extension Point 2.
- **A refusal a Merchant can act on gets a screen; the rest get an `Alert`.**
  `product-not-found` and `order-not-found` render an `Empty` with a way back to the list,
  because the only useful next move is to leave the address. Nothing predicts a refusal: every
  one is the answer to a request that was actually made.
- **The document outline lives in the frame.** The layout's `h1` names the **section**, so a
  detail screen's record title is an `h2`; the screens rendered *in place of* the routes —
  sign-in and the boot gate — carry their own `h1`, because there is none above them to inherit.
  A detail screen names its own breadcrumb through `lib/crumb.tsx`'s `useCrumbTitle`, which
  flows up rather than down: the layout owns the state and the screen writes it, because
  `GET /admin/orders/{id}` is what knows the number and a layout that fetched one would be
  fetching it twice.
- **What the Admin's sections are is `lib/sections.ts`, and there is one of it** (#177). The
  sidebar draws one entry per section and the command palette — ⌘K and Ctrl+K, built from
  shadcn's `command` — offers one row per section, and a list living in either would have been
  copied into the other. **That module is also where the sections a Role cannot read are
  hidden** (#178): `useSections` narrows the one list, never a permission check inside each
  entry — and `app.tsx`'s front door redirects to the head of *that* list, so the address
  nobody chose cannot be one this Merchant would meet a refusal on. The palette
  is the one navigation affordance a Plugin-contributed screen could use without renegotiating
  the sidebar (#71 is still open), which is why the list is data rather than markup. It closes
  onto the button that opens it — `finalFocus` on the popup, which is why it composes `Dialog`
  rather than taking `CommandDialog` whole — because choosing a section unmounts the screen
  focus would otherwise return to.
- **A permission check in the Admin is an affordance and never a boundary** (#178, ADR-0063).
  `requirePermission` in Core is the enforcement; `lib/permissions.ts` is where that is written
  down at length, because the next person to read one of these checks will assume it is doing
  security work — and would then be right to wonder why it is cached at all. Four things follow.
  **The set of Permissions is open**, so a Role's are asked by `permissions.includes(…)` and
  never as a union or a `switch`: `Session`'s own description says a deployment may hold a
  permission this build of Core has never heard of. **A section is hidden and an action is
  shown**, because a screen that 403s on load teaches nothing while a hidden button leaves a
  Merchant no way to learn the Permission is a thing to ask for. **An unavailable action is
  `aria-disabled`, never `disabled`** — a truly disabled control takes no focus and fires no
  pointer events, so it can host no tooltip and cannot be reached to be told why — which means
  the handler has to genuinely no-op, and `components/action-button.tsx` is the one place that
  is done. **That is a rule about the styling too**, which is not obvious and was shipping
  broken: a recipe under `components/ui/` that sets `pointer-events-none` on `aria-disabled:`
  puts the missing half back, and `sidebar.tsx` carried exactly that because upstream shadcn
  mirrors each `disabled:` rule onto the ARIA one (#199).
  `tests/an-unavailable-control-can-still-be-reached.test.ts` sweeps the Admin's source and
  fails naming any file that does it, which is what a `shadcn add --overwrite` would reintroduce
  in silence. The `disabled:` half is untouched, for the reason `Pager` is. A form around one needs no guard of its own: a browser performs implicit submission
  by clicking the form's default button, so Enter in a field arrives at the same handler, and
  the second guard written for it was taken out again after no case could see it go. **The
  session query is re-read on navigation as well as on focus**, through
  `useSessionOnNavigation`, and **on focus explicitly rather than by inheriting TanStack
  Query's default**, because `app.tsx` sets `defaultOptions` for that cache and a line there
  could otherwise take half of this away in silence. Both halves are asserted in the browser.
- **A contrast failure is fixed in the token layer.** `--destructive` is darker than shadcn's
  default because `text-destructive` on `bg-destructive/10` — every destructive control in this
  distribution — measured 3.99:1; `src/index.css` carries the measurement at the value. Tuning
  the two vendored components instead would have been undone by the next `shadcn add`, and
  would not have reached the components not added yet.
- **A deletion is `components/confirm-delete.tsx`, and it stays open when it is refused** (#179,
  ADR-0059). Catalog deletion refuses rather than cascading — `last-variant`,
  `stock-is-reserved` — so a delete control that looks perfectly available can still come back
  turned down, with the Merchant standing in the modal. So there is one component and it gets
  four things right on everybody's behalf: **only success closes it**, the refusal renders
  **inside** it, the previous attempt's refusal is cleared **when it is reopened** rather than
  when it closes, and its trigger is an `ActionButton` rather than an `AlertDialogTrigger`, so
  an unavailable delete opens nothing. **There is no `canDelete` prop and there must not be
  one**: whether stock is reserved is a rule living in Core that a Project may already have
  changed through a replaced Step, so the Admin attempts and renders the answer.
- **A picker over a set kobai can name is read from kobai, never written down here.** The
  Fulfilment Strategy field reads ADR-0067's route, because `physical` and `digital` in a
  `const` is ADR-0014's closed set moved into the client. It is the same rule as
  `lib/refusal.ts`'s `Record`s one step out: the Admin may hold what kobai's *types* close, and
  must ask about what a deployment decides. **A documented default is not the set**, which is
  the one thing that may still be a constant: `DEFAULT_STRATEGY` is `physical` because
  `CreateVariantRequest` promises "Defaults to `physical`" under ADR-0060, so a new Variant
  starts on the Strategy the same request without that field would have got. Starting on the
  first name the route answers with was the alternative and is worse — it is alphabetical, so
  the picker would default to `digital`.
- **A field whose options are still loading must not say the value is wrong.** The "not wired
  here" option is gated on the query having **succeeded**, not on the name being absent from an
  empty list — otherwise every ordinary `physical` Variant is labelled broken for the length of
  a round trip, and permanently if the read fails, which announces exactly the state the screen
  exists to repair about a Variant that is fine. The value is still rendered as an option while
  the list is in flight, because a picker whose value matches no option shows nothing.
- **A `Select` is given `items`, its options are wrapped in a `SelectGroup`, and "no value" is
  `null`** (#239). All three are Base UI's documented shape and this Admin had none of them, so
  each was a defect the type checker could not see. `Select.Value` renders the **raw value**
  unless `Select.Root` is handed `items`, which is why the Fulfilment Strategy picker's trigger
  read `physical` under an option reading `physical — not wired here`: build the one list of
  `{ value, label }` and draw both the options and `items` from it, rather than writing the
  options twice. The popup's padding lives on `SelectGroup` in this distribution — `SelectContent`
  renders a bare `Select.List` and puts none on it — so options that are not wrapped in one sit
  flush against the popup's edge, which is why the selects and the dropdown menus did not look
  alike. And **`null` is what Base UI means by "nothing selected"**; `""` agreed with it only by
  accident, a value serialising to `""` counting as empty for the placeholder. The *form* still
  holds `""` for the untouched field — that is what the schema refuses — and `null` is only what
  `Select` is handed. **`ui/select.tsx` itself is upstream's**, which is the point: none of this
  was a component to fix. **All three now live in `components/listbox-field.tsx` and are written
  once** (#245): each was found once and then fixed twice by hand (#244), because two fields had
  composed the vendored `Select` identically, and a third one would have got to reintroduce every
  one of them with nothing going red.
- **A popup that portals lands in the frame's container, not in `<body>`** (#179).
  `lib/portal.tsx` is the whole argument and `components/app-layout.tsx` renders the container
  inside `main`. Base UI moves a `Select`'s list and a `DropdownMenu`'s items out of the card
  they were opened from so they escape its `overflow` and stacking context — right about
  clipping, wrong about *content*: at the default target they sit outside every landmark, which
  `axe-core` reports as `region`. **The browser seam audits screens with an overlay open, so
  this fails the build**, and the theme menu had been shipping that violation since #176 with
  nothing opening it. `ui/select.tsx` and `ui/dropdown-menu.tsx` therefore take a `container` and
  default it to the frame's — the one change to what a vendored component *does*, recorded in
  `components/ui/README.md` and at each line. **A `Dialog` needs none of this**: axe excludes a
  `role="dialog"` subtree from the rule, so `ui/dialog.tsx` and `ui/alert-dialog.tsx` are
  untouched. **Vendor a new component that portals and it inherits this**, provided its
  `Content` passes `container` on; a new one that does not will be found by the first case that
  audits it open.
- **A control that is not an `<input>` is driven with `useController`, never a `useState`
  beside the form.** A listbox cannot be `register`ed — but the form still owns the value, which
  is what keeps its validation, `formState.errors` and `reset` working like every field next to
  it. **A listbox over a set kobai names is `components/listbox-field.tsx`, and there is one of
  it** (#245): it holds `useController`, the one `{ value, label }` list that draws both the
  options and `items`, the `SelectGroup`, `null` for nothing selected, and the value the list
  does not carry offered anyway so the picker can show and stay on it. A caller keeps what is
  genuinely its own — which list this is and how it is read, what to say under the field, and
  whether the read failed — which is all `FulfilmentStrategyField` and `screens/merchants.tsx`'s
  `RoleField` are now. **A third picker composed from the vendored `Select` is the thing this
  rules out**, and reaching for it anyway means answering the landmark question first.
- **Card titles are headings on the Product screen and on no other.** The frame's `h1` names the
  section and a detail screen's `h2` names the record, so the cards under it are `h3` — but only
  where the cards are *sections of one record*, which is the Product screen and its repeated
  Variants. A screen whose cards are a list of records is right to have none. `CardTitle` is a
  `div` in this distribution and is left alone; the heading is an element inside it.

