# The vendored components, and what has been changed in them

Every file beside this one was written by `shadcn add`, against the **Base UI** distribution
(`components.json` says `"style": "base-nova"`). They are ordinary source files in this Project
because that is how shadcn works — it copies source in — and they are yours to edit.

**Reach for the token layer first, and for a file here second.** Identity and density are tuned
there: `src/index.css` holds the palette, the radii and the `@theme inline` block, and a value changed
there reaches every component in this directory *including the ones not added yet*. A hand-tuned
`Button` and a `Table` added next month disagree on the day the second arrives, because
`shadcn add` writes the **upstream** version of whatever it is given. That is the whole failure
mode of "we customised our design system", arriving through a door nobody thought was a door.
[ADR-0063](../../../../docs/adr/0063-the-admins-frame-is-conventional-because-a-developer-inherits-it.md)
records the decision; app-level components — `src/components/problem.tsx`,
`src/components/pager.tsx` — are what composition looks like instead.

An edit no token can express is allowed, and the price of one is that it is **written down**,
here and at the edit itself. There is deliberately no check that diffs this directory against
upstream: it would go red on every shadcn release while telling us nothing we chose. This list
is the cheap half of that, and its value is that a departure had to be typed out by somebody.

## What has actually been changed

### Three changes to what a component does

#### Where a popup is portaled — `select.tsx`, `dropdown-menu.tsx`

`select.tsx` and `dropdown-menu.tsx` each take a `container` prop and default it to the frame's,
through `usePortalContainer()` from `src/lib/portal.tsx`. Upstream portals to `<body>`.

**It is a real accessibility failure and not a preference.** Base UI moves a popup out of the
card it was opened from so it escapes that card's `overflow` and stacking context, which is
right; leaving it at `<body>` puts *content* outside every landmark, which `axe-core` reports as
`region` — and `tests/the-admin-in-a-browser.test.ts` audits screens **with an overlay open**, so
the build fails on it. The theme menu had been shipping that violation since #176 with no case
opening it. Nothing about the escaping is given up: the popup is still positioned by floating-ui
and still leaves its card, it simply lands in a container the frame renders inside `main`.

No token can express this, which is the bar this file sets for an edit. Each of the three edited
lines per file carries a `CHANGED FROM UPSTREAM` comment pointing back here. `dialog.tsx` and
`alert-dialog.tsx` are deliberately **not** changed: axe excludes a `role="dialog"` subtree from
the region rule, so they were always green, and `tooltip.tsx` is not either — `action-button.tsx`
hides its popup from the accessibility tree, so there is no content there to be outside anything.

**If `shadcn add select --overwrite` or `--overwrite` on the menu reverts this, the browser seam
goes red**, naming the screen and the rule. That is the intended way to find out.

#### Where the Sidebar puts what it is given — `sidebar.tsx`

`Sidebar`'s narrow branch spreads `{...props}` onto the `<div>` wrapping its children, inside
`SheetContent`. Upstream spreads it onto `Sheet` itself.

**`Sheet` is a Base UI dialog *root*, which renders no element at all**, so everything a caller
gave `Sidebar` was swallowed there — while the two branches either side of it spread onto a real
`<div>`. `components/app-layout.tsx` passes `role="complementary"` and an `aria-label` so the
sidebar's contents sit in a named landmark, which is one of the four accessibility faults #175
found and fixed on the frame; below `md` that pair reached nothing, so **this Admin had no
sidebar landmark on a phone at all** (#193). No token can express which element a component
spreads its props onto, which is the bar this file sets for an edit.

Both edited lines carry a `CHANGED FROM UPSTREAM` comment. **A `shadcn add sidebar --overwrite`
reverts this silently as far as any scanner is concerned** — `axe-core` excludes a
`role="dialog"` subtree from the `region` rule, so the missing landmark is not a violation it
reports, and the seam's own audits stayed quiet on it in both directions. What goes red is
`tests/the-admin-in-a-browser.test.ts`'s narrow-window cases, which ask for the landmark **by
name** for exactly that reason.

**Nothing else in this directory has this shape, and that was checked rather than assumed.**
`hooks/use-mobile.ts` is read by `sidebar.tsx` and by no other file, and `sidebar.tsx`'s is the
only component here that renders a different element per branch. The five other wrappers around a
state container — `dialog.tsx`, `alert-dialog.tsx`, `sheet.tsx`, `dropdown-menu.tsx` and
`tooltip.tsx` — each declare their primitive's own props rather than an element's, so handing one
a `role` is a **compile error** instead of silence. `Sidebar` was reachable only because it
declares `React.ComponentProps<"div">` and then spreads the rest somewhere that is not a `div`.

#### What an unavailable control may still receive — `sidebar.tsx`

`sidebarMenuButtonVariants`, and the recipe `SidebarMenuSubButton` writes inline, no longer
carry `aria-disabled:pointer-events-none`. Upstream mirrors each of its `disabled:` rules onto
`aria-disabled:`, which reads like tidiness and is the one thing ADR-0063 and #178 rule out.

**An action a Role cannot perform is `aria-disabled` rather than `disabled` precisely so that
it can still be reached and told why.** A truly disabled control takes no focus and fires no
pointer events, so it can host no tooltip and no explanation — which is the whole reason the
decision picks the ARIA attribute over the real one. A recipe that then sets
`pointer-events-none` on that attribute puts the missing half back: the control cannot be
hovered, so it can host no tooltip either, and the affordance is defeated in silence.
`buttonVariants` in `button.tsx` styles `disabled:` only, never `aria-disabled:`, which is why
`src/components/action-button.tsx` works at all.

The `disabled:` half is deliberately untouched, in both recipes. A control dead only while a
request is in flight has nothing to explain and nobody to explain it to — the same line
`components/pager.tsx` draws when it uses a real `disabled` for its dead Next and Previous.

No sidebar control is `aria-disabled` today, so nothing was visibly broken; #180 puts Merchants,
Roles and the Store on this frame, and a sidebar action a Role cannot perform is a plausible
thing for it to want. **This one is held by a test rather than by this list** —
`tests/an-unavailable-control-can-still-be-reached.test.ts` sweeps the whole of the Admin's
source — this directory, the app-level components above it, and the copy under
`packages/create-kobai/template/` a Developer receives — and fails naming any file that puts the
variant back, which is what a `shadcn add sidebar --overwrite` would do. Both edited lines carry a `CHANGED FROM UPSTREAM`
comment.

### A gap recorded rather than fixed — `tooltip.tsx`

**Base UI's tooltip is announced as nothing** (#199). At the version this Admin pins it gives
its popup no `role="tooltip"` and sets no `aria-describedby` on the trigger — checked in the
installed package, not assumed — so a tooltip here is a **visual** affordance and a screen
reader is told about none of it.

`tooltip.tsx` is therefore **not** in the list above: what it *does* is exactly what
`shadcn add` wrote, and the only departure in it is the note at its head saying so — which
carries a `CHANGED FROM UPSTREAM` line like every other, because an `--overwrite` deletes a
comment as silently as it deletes a fix. What is written down here is the gap.
**Never put information only in a tooltip.**
`src/components/action-button.tsx` is the shape to copy where something must actually be
announced — the sentence again in an `sr-only` span, the control described by *that*, and the
popup `aria-hidden` so it is neither read twice nor reported by axe as content outside a
landmark.

Fixing the primitive was weighed and refused. A `role` and an `aria-describedby` would be
honest and would still not replace that workaround, because Base UI unmounts the popup when it
is closed: the description would resolve to nothing for exactly the reader who never opens the
tooltip. It would also make the popup announced content portaled to `<body>`, dragging in the
container plumbing `select.tsx` and `dropdown-menu.tsx` carry above — and
`shadcn add tooltip --overwrite` would revert all of it silently. The reasoning is repeated at
the head of the file, where somebody about to reach for a tooltip will meet it, and
`tests/an-unavailable-control-can-still-be-reached.test.ts` asks both copies for it by name —
so an overwrite that takes the note away is a red build rather than a quiet loss.

### The rest are suppression comments

`pnpm run ci` fails on any Biome finding at any severity (ADR-0039) and upstream shadcn is not
written against this repository's lint configuration. Each one sits at the line it suppresses.

| File | Rule suppressed | Why it is upstream's call and not ours |
| --- | --- | --- |
| `field.tsx` | `a11y/useSemanticElements` | `Field` is `role="group"` on a `<div>`. A `<fieldset>` cannot be styled with the flex rules the variants need, which is why upstream does it this way. |
| `field.tsx` | `suspicious/noDoubleEquals` | `uniqueErrors?.length == 1`. `length` is always a number, so `==` and `===` agree here. |
| `field.tsx` | `suspicious/noArrayIndexKey` | The error list is rebuilt whole on every validation, so there is no identity for a key to preserve. |
| `breadcrumb.tsx` | `a11y/useFocusableInteractive`, `a11y/useSemanticElements` | `BreadcrumbPage` is `role="link" aria-disabled` on a `<span>` — the current page, which is deliberately not a link and deliberately not focusable. |
| `pagination.tsx` | `a11y/noRedundantRoles` | `role="navigation"` on a `<nav>`. Redundant, and harmless. |
| `sidebar.tsx` | `suspicious/noDocumentCookie` | The sidebar remembers whether it is open in a cookie of its own. It is not kobai's session cookie and carries nothing (ADR-0032 is about the other one). |
| `sidebar.tsx` | `correctness/useExhaustiveDependencies` (twice) | Two hooks list `setOpenMobile`, which React guarantees is stable, so the dependency is unnecessary rather than wrong. |
| `input-group.tsx` | `a11y/useSemanticElements` (twice) | `InputGroup` and `InputGroupAddon` are `role="group"` on a `<div>`. A `<fieldset>` cannot be styled with the flex and `has-[…]` rules the variants need, which is the same reason `field.tsx` does it this way. |
| `input-group.tsx` | `a11y/useKeyWithClickEvents` | `InputGroupAddon`'s `onClick` forwards a click on the addon to the input beside it — a larger hit area for a control that already has the keyboard, so there is no keyboard action to mirror. |

Take an entry out when upstream does — `shadcn add <name> --overwrite` will tell you, because the
suppression is one of the things it overwrites.

## Adding another component

**The command is in `AGENTS.md`, under "The Admin"**, along with the rule about moving whatever
it writes into `dependencies` over to `devDependencies` — `vite build` inlines this whole tree,
so nothing here is needed by the process at runtime. It is not repeated here, because two
copies of a command are two answers to one question the day one of them is edited.

Two things this file can add. Run `pnpm run format` afterwards: what the CLI writes is not
formatted the way this repository formats, and the gate fails on the difference.

And **answer `no` when it offers to overwrite a component that is already here.** It rewrites
the file with the upstream version, which reverts both the formatting and every suppression
above — which is exactly how you find out whether upstream has fixed one, and exactly how you
lose them all if you were not looking.
