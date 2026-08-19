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

### One change to what a component does: where its popup is portaled

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

### The rest are suppression comments

`devbox run ci` fails on any Biome finding at any severity (ADR-0039) and upstream shadcn is not
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

Two things this file can add. Run `devbox run format` afterwards: what the CLI writes is not
formatted the way this repository formats, and the gate fails on the difference.

And **answer `no` when it offers to overwrite a component that is already here.** It rewrites
the file with the upstream version, which reverts both the formatting and every suppression
above — which is exactly how you find out whether upstream has fixed one, and exactly how you
lose them all if you were not looking.
