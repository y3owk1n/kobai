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
pnpm --filter kobai-reference-admin exec pnpm dlx shadcn@latest add <name>
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
origin is what ADR-0010 spends the single container on. The dev loop keeps it: `pnpm run
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
case. `pnpm run browsers` downloads the browser and `pnpm run ci` and `pnpm run test`
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
  like paging working, and is a different question being answered. Two lists narrow today and one
  of them narrows twice — Carts by `?state=live|expired|spent` (ADR-0071), Products by
  `?status=draft|published|archived` (#252) **and** by `?collection=` (#256) — and **a narrowing
  is `components/list-filter.tsx`, of which there is one** (#252). A filter is a set of **links**
  rather than a control with a value, for the reason the cursor is in the URL at all: each value
  is an address a Merchant can send and a refresh lands on. Choosing one **drops** the cursor,
  since a cursor locates a page of the list that issued it, **and keeps every other narrowing
  untouched** — which is the rule the third caller added and the one a hand-copied nav would not
  have had: two filters that each clear the other look exactly like two filters that work, one
  click at a time, and the browser seam is where that is watched (#256). The second copy of that nav was
  verbatim, comments included, which is `listbox-field.tsx`'s lesson arriving one noun along:
  extract on the second, because the third is what gets to reintroduce every defect the first
  two had fixed by hand. `useListFilter` is the other half and holds the part that is easy to
  get subtly wrong — **an address can name a value kobai has never heard of**, and both obvious
  answers are worse than saying so: filtering by nothing shows the whole table under a heading
  claiming otherwise, and sending the word on spends a round trip to be refused with `invalid`.
  So the query is keyed on what the *address* said rather than on the value it narrowed to, and
  a screen keeps its own empty state for the word — different lists, different prose.
- **A list a Merchant edits as a whole is one form over the whole list**, because that is how the
  route reads it. The Product screen's Options card is the case (#253): kobai takes `options` as
  what the Product's options should now *be*, so renaming, reordering, adding and removing are one
  request and the screen is a `useFieldArray` with Up, Down and Remove beside each row — and the
  order is the rows' own order, so there is no position to type and nothing to keep in step. Two
  things about it are easy to get wrong. **`useFieldArray` writes a key of its own onto each field
  and that key is called `id`**, so an option's real identifier is held under `optionId` and mapped
  back on submit; losing it would turn every rename into a removal and an addition, taking every
  Variant's value with it. And **Up, Down and Remove are plain `Button`s rather than
  `ActionButton`s**: they rearrange the form and call kobai nothing, so there is no permission to
  explain — the one control that writes is the submit, and that is where `unavailable` goes.
- **A list of images is `components/media-attachments.tsx`, and there is one of it** (#255). It
  is the Options card's shape one noun along — one form over the whole list, `useFieldArray`,
  Up, Down and Remove beside each row, the order being the rows' own order — because kobai reads
  `media` as what the subject's images should now *be*. It is a component on the *second* use
  rather than the third, which is `listbox-field.tsx`'s lesson: the Product screen renders one
  for the Product and one inside every Variant card, so a copy would be four by the time a
  Product has two sizes. Three things about it are decisions. Its `mediaId` is under that name
  and not `id`, for exactly the reason the Options card's `optionId` is. Its picker is a
  `ListboxField` over `GET /admin/media` — a set kobai names, so it is read from kobai — and it
  asks for `limit=100` and **does not page**: a pager inside a card would put a second cursor in
  an address that already locates a Product, and the several copies on the screen would fight
  over it, so a Store with more than a hundred images and an old one to attach is a **known gap**
  rather than something this hides. And **the card says that Remove detaches rather than
  deletes**, because a Merchant who thinks otherwise will not press it and one who is wrong about
  it has lost a photograph (ADR-0082).
- **The Media screen is the one form in this Admin that is not JSON, and it is the one that
  does not use react-hook-form** (#254). A file input's value is a `FileList` the browser owns
  and nothing may set, so `reset()` cannot clear it and the controlled value every other field
  here relies on does not exist — the file is held in state beside a `ref` used only to clear
  the input after a successful upload, and "a file was chosen" is expressed as the submit button
  being dead rather than as a schema message. The request goes through `@kobai/client` like
  every other call, with a `bodySerializer` building the `FormData`: `openapi-fetch` hands one
  on untouched and leaves the boundary to the browser, which is the only party that can make
  one. **Each row renders `media.url` exactly as kobai answered it** — absolute for a Store on a
  CDN, root-relative for the storage kobai ships — because building an address out of a key here
  would be a second answer to a question the API already answers, and wrong on the first
  deployment that moved its bucket. Its `alt` is `one.alt ?? ""` on the `<img>`, which is what a
  screen reader is told about a decorative image; inventing prose there would announce a
  filename.
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
  **Every section carries a `group`, and the sidebar is the only reader of it** (#266,
  ADR-0079). Commerce, Settings and Developer, in that order, with the field required on every
  entry rather than optional and set once — which is the shape that stays set once forever. The
  sidebar draws `useGroupedSections`, which is a *view* of the narrowed list and never a second
  narrowing, and it **drops a group that holds nothing**, because a heading over an empty list
  reads as a list that failed to load. **The palette stays flat**: a palette that nests is a
  menu, and what it is good at is answering a typed word with a destination — so it and the
  front door read the flat list, one row per section and one head. **The order inside a group is
  load-bearing, and reordering one is a decision about the front door**: it lands on the head of
  the narrowed list, so a section moved past another moves the landing of every Role that reads
  the second and not the first. Settings therefore reads Merchants, Roles, Store — the order
  those three already had — and API keys moving into Developer is the one landing this ticket
  could not preserve. **An address moved with its
  screen and no redirect was left behind**: API keys is at `/developer/api-keys`, `/api-keys`
  is an address no screen answers, and a redirect would be permanent furniture in vendored
  source `kobai-upgrade` can never reach. `sectionOf` is why an address a hyphen away from
  another still lights the right entry — it matches at the `/` boundary and never by bare
  prefix.
- **The Playground reads the description over HTTP, and it is the only screen whose data is a
  document rather than a record** (#268, ADR-0080, ADR-0081). `screens/playground.tsx` renders
  it and `lib/description.ts` is the reading — every field narrowed out of an **open object**,
  because `@kobai/client` types this one as `{ [key: string]: unknown }` and an OpenAPI document
  is a recursive schema kobai does not own. What follows is what a reader cannot infer from it.
  **It could not have been bundled**: the client is types and TypeScript erases them, so the
  Admin's bundle holds no description at all, and `@kobai/core/openapi.json` is a *package's
  build artifact* rather than this server's answer — which is why `GET /admin/openapi.json`
  exists at all, and the ban on importing `@kobai/core` is only the second reason.
  **The chosen operation is in the address**, as `?operation=GET /admin/products` — the method
  and the path, because an OpenAPI document promises no `operationId` and kobai's carries none,
  and because #269 puts the parameters and the body in that same search.
  **What is typed into the search box is deliberately *not*** — this is the one narrowing in
  this Admin that is not a link, and the difference is that it narrows a document already in
  memory rather than issuing a list: a history entry per keystroke would sit between a
  Developer and the back button they leave an operation with.
  **The grouping is derived from the paths and never written down here.** kobai's description
  carries no `tags`, and a table of resource names in this tree would be exactly the closed set
  ADR-0067 rules out — so a heading is the path up to its second segment, and the surface alone
  where that segment is a parameter. **Every reader in `lib/description.ts` answers `undefined`
  rather than throwing**: a document missing a field is a deployment describing itself oddly,
  not a reason to blank the screen that reads it. And **a schema tree stops on a component it
  has already expanded**, which is what terminates a recursive document — `DEEPEST` is a
  backstop behind that and not the mechanism.
  It composes **one** read, at the screen's root rather than inside a card, so it is not a
  second use of the Deployment screen's local `ReadCard` and nothing was extracted.
- **The Playground sends real requests, and `lib/playground-request.ts` is the whole of how**
  (#269, ADR-0081). Four things about it are decisions rather than implementation, and the
  first is load-bearing enough that the screen is not worth having without it.
  **`credentials: "omit"` on anything but the Session.** The session cookie is scoped to
  `/admin` by the path of the *request* rather than of the page (ADR-0032), so a publishable
  key sent at an admin route **succeeds via the cookie** unless the request suppresses it — and
  the screen then teaches that a `kobai_pk_…` opens the admin surface, which is the only outcome
  worse than not building it. The line is written as a value on **every** request —
  `"same-origin"` or `"omit"` — so neither branch reads as an oversight, and
  `tests/the-admin-in-a-browser.test.ts` holds it with a case that has been **watched failing**:
  pinned to `"same-origin"`, that request comes back 200 and a list of Products. Nothing smaller
  than a real cookie jar can see it.
  **It builds its own client and must not use the frame's.** `createAdminClient`'s middleware
  reads a 401 as "this session is over" and blanks the session query, and a publishable key at
  an admin route answers exactly that — so on the frame's client the demonstration above would
  drop a Developer onto the sign-in screen mid-request. `createPlaygroundClient` in
  `lib/kobai.ts` is the one without it: here a 401 is **an answer to render**, not news about
  the tab.
  **The cast lives in that one file**, because `openapi-fetch` types every call against a
  literal path and a description-driven sender has none —
  `tests/admin-uses-only-the-public-api.test.ts` names the file and fails on any other, and on
  any call handed a path it composed. Both halves have been watched failing. Without it that
  scan, which reads *quoted* path literals, would be **silently vacuous over the one screen that
  can reach anything**.
  **Arming is an affordance and never a boundary**, and it guards exactly one case: a non-`GET`
  on the *Session*, the credential nobody had to type. `lib/arming.ts` holds it in
  `sessionStorage` so it lasts the session rather than the render, and `lib/session.tsx` forgets
  it on sign-out beside the preview key. A pasted or publishable credential needs none —
  ceremony on the safe case is how a guard gets taken off the dangerous one.
  Three more things a reader cannot infer. **The composed request is in the address** —
  `?operation=`, `?credential=`, `path.…`/`query.…`/`header.…` and `?body=` — written with
  `replace` rather than `push`, for the search box's reason: a history entry per keystroke sits
  between a Developer and the back button. **The pasted secret key never is**, and is never in
  browser storage either: it lives in the screen's own state and is gone on reload, because the
  rule ADR-0055 protects is that the Admin never *mints* and never *stores* a secret key. And
  **the publishable key is the one the Admin already holds** — `heldPreviewKey` in
  `lib/preview-key.ts`, extracted there on the second caller, so a Merchant's API keys list
  keeps one line meaning "the Admin itself".
  **Nothing is validated in the browser.** Parameters are fields built from the description and
  the body is a box seeded from the request schema (`seedBody`, which seeds the **required**
  fields and invents nothing); an invalid one is refused by Core and that refusal is the
  documentation. **The two session operations are listed and get no send control, plus a
  sentence saying why** — ADR-0081 carries the answer in full, and the short version is that an
  operation which silently lacked a button would teach nothing.
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
- **The storefront price preview asks over `/store` when a storefront could and over `/admin`
  when none could, and it says which** (#276). Asking by *being* a storefront — a publishable
  key, a second client, `GET /store/variants/{id}/price` — is the whole point of that screen and
  is unchanged for a Product that is on sale. It cannot be the answer for a **draft**, because
  the store surface answers no draft at all, and previewing a price before putting something on
  sale is exactly when a Merchant wants one: so an unpublished Product is asked at `GET
  /admin/variants/{id}/price`, which runs the same `resolve-price`. **It is a branch and never a
  fallback** — a screen that tried `/store` first and retried on a refusal would paper over real
  refusals on Products that *are* published — and the caption under the control names the
  surface, because "what a storefront receives" and "what one would receive if you published
  this" are two sentences. Which of the two it did is asserted in the browser seam, on the
  requests the page made, since nothing on screen can show it. The Permission follows the ask:
  `api-key:write` for the storefront's (the first ask on a session with none mints the key) and
  `catalog:read` for the Merchant's.
- **A picker over a set kobai can name is read from kobai, never written down here.** The
  Fulfilment Strategy field reads ADR-0067's route, because `physical` and `digital` in a
  `const` is ADR-0014's closed set moved into the client. It is the same rule as
  `lib/refusal.ts`'s `Record`s one step out: the Admin may hold what kobai's *types* close, and
  must ask about what a deployment decides. **A vocabulary that is nobody's decision is asked of
  the browser** (#300), which is the one set here that is neither: `lib/currencies.ts` is ISO 4217
  out of `Intl.supportedValuesOf("currency")` with `Intl.DisplayNames` for the names, because
  which three-letter codes exist is a standard that changes without us, kobai holds no table of it
  either, and a route for it would be Core promising a vocabulary it does not own. A bundled
  dataset and a seeded `core_currency` table with a route in front of it were both weighed and
  refused — the table would additionally close a vocabulary Core deliberately left open
  (`core_store_currency` has a length check and no foreign key), and would carry names in one
  language where `Intl` localises. That is the Store screen's *enable* field; a **Region's**
  currency is the enabled set and so is read from kobai through `lib/store.ts`, which is the
  ordinary rule. Two things follow from the difference and neither is decoration. **The one over
  a browser's list suggests and does not fence**: a code this runtime does not list is offered
  anyway and goes up upper-cased, and a runtime with no `Intl.supportedValuesOf` at all keeps the
  plain text box, because this screen is the only way a Merchant reaches a route that takes any
  three-character code and a gap in a browser must not become a gap in kobai. **The one over the
  Store's enabled set stays shut**, since `currency-not-enabled` is a real refusal and there is
  nothing to escape to. Fall back to the bare code where a runtime has no display name — a row
  reading `undefined` is worse than either.
  **Naming a code and choosing which codes exist are two questions, and separating them is what
  makes three screens agree.** `currencyLabel` is the whole of the first and `lib/store.ts` calls
  it on the enabled set, so the Region screen, the New Region form and the Price editor's
  currency field render one list built in one place — no screen shows a bare code where another
  shows a named one, and `ringgit` finds the row on all three. A fourth spelling of those options
  is the thing this rules out. The Price editor's `This Store's default` is the one row in any of
  them that is **not** a currency: it keeps its own words rather than being named after a code,
  and typing one narrows past it, which is right — a Merchant reaching for `MYR` is not reaching
  for the default. **A documented
  default is not the set**, which is
  the one thing that may still be a constant: `DEFAULT_STRATEGY` is `physical` because
  `CreateVariantRequest` promises "Defaults to `physical`" under ADR-0060, so a new Variant
  starts on the Strategy the same request without that field would have got. Starting on the
  first name the route answers with was the alternative and is worse — it is alphabetical, so
  the picker would default to `digital`. **A set two controls both ask for is a module**, on the
  extract-on-the-second rule the two components above already carry: `lib/collections.ts` is that
  set for Collections (#256), read by the Products list's second filter and by
  `components/collections-field.tsx`, and it reports *whether kobai has answered* beside the list
  because every caller needs to tell "the Store has none" from "nobody has asked yet". It asks
  for a hundred and **does not page**, which is `components/media-attachments.tsx`'s known gap
  arriving one noun along, and it is written down there rather than here for that reason.
  **The picker over that set is one component too** (#280): the Product screen's Collections card
  and the New Product form ask a Merchant the same question, because `collections` is on
  `POST /admin/products` as well as on the correction — so the checkboxes, the skeleton and the
  hundred-and-first Collection offered anyway live in `components/collections-field.tsx`, and it
  takes `control` and `name` like `permissions-field.tsx` rather than a value and a callback. Two
  things stay the callers': what a Store with **no** Collections is told, which is a sentence on
  the card and nothing at all on the create form — a Merchant filling one in did not come looking
  for Collections — and, at a create, that `collection-not-found` is now a refusal that form can
  really meet, by a Collection deleted since the list was read.
  **`lib/markets.ts` is the same module for Regions and Channels** (#292), and it was extracted
  on the second caller like the rest: the Price editor asks for both, and the mint-a-key form
  was already asking for Channels under a cache key of the same name — two definitions of one
  entry, which is worse than either. **Extracting it did not by itself remove the second
  definition**, which is the part worth knowing: the Store screen's Default Region card kept a
  `useQuery` of its own on `"offered-regions"` with a limit of its own for eight more tickets
  (#311), so whichever of the two mounted first decided what the other read. The two limits
  happened to agree at a hundred, which is exactly why nothing pointed at it. **A screen that
  wants a set this module owns calls the hook**, and a `useQuery` in a screen whose key another
  file also spells is the shape to go looking for.
  **That module follows kobai's cursor to the end since #310, and it is the one of these hooks
  that does.** A limit of a hundred with no paging is a picker that offers a *prefix* of the
  answer — indistinguishable from a complete one, which is why the gap survived two tickets that
  touched the file — so a deployment past a hundred Regions had markets it could not price for
  and could not make its default. It reads page after page until `nextCursor` is absent, which
  is the only end-of-list signal there is (ADR-0064), under a **bounded** loop for the reason
  every cursor walk in this repository is bounded: a cursor that never advanced would spin
  rather than fail, and a tab that never settles is worse than a short list. Reaching that bound
  is a finding about the control — **a Store with thousands of markets wants a screen with a
  search box rather than a longer listbox** — not a limit to raise.
  **`lib/collections.ts` and `components/media-attachments.tsx` still stop at a hundred**, and
  that stays a known gap rather than an oversight: this ticket's criterion was the market
  pickers, and the same fix is available to both the day one is asked for.
  `tests/the-admin-in-a-browser.test.ts` is where the paging is held, in the file's **last**
  case — it arranges a hundred and one of each, which is an arrangement no case after it should
  inherit — and it was watched failing against a read that stopped at one page.
  Three things about the Price editor are decisions rather
  than implementation. **The currency follows the chosen Region as a suggestion and never as a
  rule**: a Price denominated in something that Region does not select is a row kobai accepts
  and `select-price` can never pick, so the field *starts* on the right answer rather than the
  form refusing the wrong one, which would be the Admin holding a rule that lives in Core.
  **Unconstrained is an option and not an empty picker** — `Every Region` heads the list, on the
  argument the mint form's `In no particular Channel` already carries: it is the commonest Price
  there is and a Merchant should be able to choose it on purpose. And **Supersede sends the
  Price's own Region, Channel and currency**, because superseding means replacing *this* row: a
  Merchant correcting what Malaysia pays must not be handed a Price for everywhere.
- **A field whose options are still loading must not say the value is wrong.** The "not wired
  here" option is gated on the query having **succeeded**, not on the name being absent from an
  empty list — otherwise every ordinary `physical` Variant is labelled broken for the length of
  a round trip, and permanently if the read fails, which announces exactly the state the screen
  exists to repair about a Variant that is fine. The value is still rendered as an option while
  the list is in flight, because a picker whose value matches no option shows nothing.
- **A picker over a set kobai names has three states, and an empty list is two of them** (#311).
  *Nobody has asked yet*, *kobai answered and the Store has none*, and *the read failed* draw the
  identical control, so a hook that reports only the first two leaves its callers unable to say
  which — and the sentence a screen falls through to is then wrong in the worst direction, since
  *enable a currency on the Store screen* is advice to a Merchant whose Store very likely has
  one. So **every one of these hooks answers `error` beside whether kobai has replied** —
  `lib/store.ts`, `lib/markets.ts`, `lib/collections.ts`, the last of which spells the same two
  fields `read` and `pending` — and a screen renders it **in the field's own `description`**, through
  `problemOf`, with the control `disabled`. Being merely dead is not saying so: a disabled picker
  reads as one that has not loaded. **The sentence is a function next to the hook** —
  `whyCurrenciesNotRead`, `whyRegionsNotRead`, `whyChannelsNotRead` — which is
  `lib/currencies.ts`'s rule one question along: naming the failure and deciding which screens
  show it are two questions, and separating them is what stops a fourth spelling of *kobai did
  not say*. **Every picker over one of these sets was fixed in one change, deliberately**, because
  the alternative is repairing this defect one screen at a time — which is how it survived #300
  and #292 both. **The API keys screen's Channel picker is the one that does not fall through**, and it
  is the case worth reading before writing the next one: `In no particular Channel` is a real
  answer rather than an empty-set placeholder — the one most keys want and every key that exists
  today — so a failed read there costs a Merchant the *other* rows and nothing else, and the
  field says the read failed **and** that the ordinary key can still be minted. Naming a failure
  belongs to the module; what is still possible in spite of it belongs to the caller.
  **`tests/a-read-that-failed-is-not-discarded.test.ts` holds all of this that a scan can
  hold**, and its own header is where the boundary is argued: it reads the modules and the call
  sites out of the tree, so a `lib/` read written tomorrow is swept the day it exists, and it
  claims that a failure is *taken* rather than that it is rendered well. Its first run found a
  third instance nobody had reported — the Products list dropped `error` at the destructure, so
  a failed Collections read simply removed the Collection filter, which is what a Store with no
  Collections looks like.
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
- **A list too long to look through is `components/combobox-field.tsx` instead** (#300), and the
  two are separate components rather than one with a `filterable` flag. Base UI draws the line
  and it is the list that decides: a `Select` is a listbox, a `Combobox` is the same list behind a
  box you type in, and a search field over the two Fulfilment Strategies a deployment wired is
  noise. ISO 4217 is the case that earned it — the Store screen's `store-enable-currency` offers
  `Intl.supportedValuesOf("currency")`, which is a few hundred rows, and a Merchant who knows they
  want `MYR` should type it. What is typed is matched against the **label**, so a caller that puts
  a code and a name in one label gets both searchable for nothing. Everything else it holds it
  holds for `listbox-field.tsx`'s reasons, and one thing is its own: **the box lives inside the
  popup, and that is not a matter of taste.** With the box outside — the arrangement that looks
  like a text field — Base UI's focus manager is modal and `aria-hidden`s everything the popup is
  not, the field's own label and the frame's `h1` included; axe reports `label`,
  `page-has-heading-one` and `aria-hidden-focus` for it, which is a red gate and a real fault.
  Inside, the popup is a `role="dialog"` — so **this one needs none of the portal plumbing above**,
  for `ui/dialog.tsx`'s reason, and `ui/combobox.tsx` is exactly what `shadcn add` wrote. The
  browser seam drives it through the dialog's own search box, and was watched failing on the other
  arrangement. **Whether a Merchant may type a value that is on no row is the caller's**, through
  `novel`, because it is a question about what kobai will accept rather than about the control:
  closed is the default and the Store's enable field is the one caller that opens it. The two
  fallbacks it exists for are reachable in no other way, so the seam arranges them by taking the
  `Intl` function away in an init script — the one place in that file where the *runtime* rather
  than the deployment is what a case arranges.
- **A field whose *set* comes from the record above it is built from that record.** Each Variant
  card renders one value field per option **the Product** declares — not per value the Variant
  happens to hold — which is what makes an option declared a moment ago appear as an empty required
  field on every Variant rather than not at all. kobai leaves those Variants unanswered on purpose
  and `PATCH /admin/variants/{id}` is the repair, so rendering the Product's list is rendering the
  repair. The values are **always** sent, because that route replaces what is stored rather than
  merging into it, exactly as `metadata` does — **so the form asks for every value even when the
  Merchant came to fix a SKU**, which is a narrowing of what the route itself allows and is
  deliberate: one form over a Variant is what ADR-0062's "an absent field means leave it" buys
  the *client*, and splitting the submit to preserve it would mean two Save buttons on one
  fieldset to spare a Merchant one field they have to fill in anyway.
- **Card titles are headings where the cards are sections of one record**, and on the two
  screens where they are. The frame's `h1` names the section and a detail screen's `h2` names
  the record, so the cards under it are `h3` — which is the Product screen with its repeated
  Variants, and the Playground's operation panel, whose Parameters, Request body, Answers and
  Refusals are four sections of one operation. A screen whose cards are a list of records is
  right to have none. **The Playground's operation *list* is the one exception and it argues
  itself at the line** (#268): that card is a list, and it carries an `h2` anyway because the
  screen is two panels standing beside each other and the groups inside it are `h3`s — with no
  `h2` over them the outline would jump straight from the frame's `h1`, and somebody navigating
  by heading would have no way back to the list from an operation. `CardTitle` is a `div` in
  this distribution and is left alone; the heading is an element inside it.

