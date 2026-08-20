# The Admin takes a second audience, and it is one app

**The Admin grows a `Developer` group** — API keys, **Playground** (the deployment's own
description, browsable and runnable), and **Deployment** — and its sections become three groups:
**Commerce** (Products, Media, Orders, Carts), **Settings** (Store, Merchants, Roles) and
**Developer**. The three sit at `/developer/api-keys`, `/developer/playground` and
`/developer/deployment`. It stays
**one SPA, at one origin, in the one container**
[ADR-0010](./0010-the-admin-ships-in-one-container-and-gets-no-private-api.md) spends.

`CONTEXT.md` changes with it. The Admin was "the pre-built UI a Merchant works in"; it is now
that, and in one section a Developer's. That sentence is the decision — everything below is why
it was cheaper to admit than to avoid.

## Why the Admin gets a second audience at all

The questions a Developer has about a running kobai are questions **about that deployment**:
which routes does it serve, which Steps has it replaced, which migration sets applied, does this
key work. Today the only thing that can answer them is a shell on the container. A Developer
holding a browser tab open on the Admin has, in that tab, a signed-in, same-origin, fully
authenticated client of the exact API they are asking about — and is told nothing.

**The first screen of this group already existed**, which is the tell. API keys is a Developer's
screen wearing a Merchant's clothes: it mints `kobai_pk_…` and `kobai_sk_…` for a storefront,
its own docs explain the prefix convention to whoever ships the key, and no part of it is about
running a shop. It sat in a flat list beside Products because there was nowhere else to put it.
Moving it is not a reorganisation for tidiness; it is the list finally having the category the
screen was always in.

**ADR-0010 predicted the rest of it.** That record gives the Admin no private API *precisely* so
that a capability it lacks surfaces as a finding about the public surface — which is how
[ADR-0067](./0067-a-set-the-deployment-declares-is-not-a-list-route.md) came to exist. Two more
findings fell out of this one and are
[ADR-0080](./0080-a-deployment-describes-itself.md)'s: nothing serves the deployment's own
description, and nothing answers what it has been configured into.

## Why it is not a second app, which is the part that surprises

The obvious shape — a separate playground app, so a Developer's experiments cannot touch the
Merchant's credentials — **does not work**, and the reason is a fact about cookies rather than a
preference about architecture.

A cookie is scoped by the path of the **request**, not by the page that made it.
[ADR-0032](./0032-merchant-sessions-travel-in-an-httponly-cookie.md) sets `kobai_session` with no
`Path`, so RFC 6265 files it under the default-path `/admin` and the browser sends it to that
subtree **from any page on the origin**. A second SPA at `/playground-ui` presents the Merchant's
session on every `/admin/*` call exactly as `/admin-ui` does. `sessionStorage` is origin-scoped
too, so the storefront preview key in `lib/preview-key.ts` is shared as well. **A separate app on
the same origin isolates nothing whatever.**

The other direction is closed by two things at once. A separate *origin* needs CORS, which
`docs/agents/the-admin.md` already rules out — one origin is what ADR-0010 spends the single
container on — and `SameSite=Strict` means a cross-origin app would receive the session cookie
**never**, on any request. That is real isolation, bought by deleting the `/admin` half of the
tool. It answers the credential worry by removing the capability the tool exists for.

So there is no middle in a browser. The credential concern that motivates a second app is answered
in [ADR-0081](./0081-the-playground-attaches-its-credential-and-omits-the-ambient-one.md)
instead, by making the credential explicit rather than by moving the code that sends it.

## What a second app would have cost, had it worked

Worth recording, because the idea will come back:

- **A second `components/ui/`.** The Admin is vendored source, not a workspace — so the shadcn
  set is either copied, which is the drift the "extract on the second" rule exists to stop, or
  hoisted into a shared local package that is new structure every generated Project inherits.
- **A second browser seam.** `tests/the-admin-in-a-browser.test.ts` boots a real Project and
  audits every screen with `axe-core`; a second app needs its own harness, its own audit and its
  own narrow-window case.
- **A second `base`, and a second half of it.** `docs/agents/the-admin.md` records that where the
  Admin is served is said **once**, in `vite.config.ts`, and held equal to `ADMIN_PATH` by a test.
  Two apps is two of those pairs.
- **`kobai-upgrade` reaches neither** ([ADR-0035](./0035-upgrading-is-a-command-kobai-ships.md)),
  so every one of those costs is permanent for the Developer who inherits them.

## Why every section is grouped, not just this one

Three groups rather than six loose entries beside one nested one. A sidebar with two organising
principles reads as an afterthought, and — more concretely — it makes `group` an *optional* field
on `Section` that is set once, which is the shape that quietly stays set once forever. Every
entry carrying a group is a smaller change to `lib/sections.ts` than a special case would be, and
`components/command-palette.tsx` already draws a `CommandGroup heading="Sections"`, so the palette
carries the headings without gaining a concept.

**The palette stays flat.** A command palette that nests is a menu, and the thing it is good at
is answering a typed word with a destination.

**`app.tsx`'s front door must still land where it lands.** It redirects to the head of the
*filtered* list ([#178](https://github.com/y3owk1n/kobai/issues/178)), so grouping must not change
which section an existing Role arrives at — Commerce is first, and Products is first inside it,
which is what it was.

**Media joins Commerce, and it is the reason to do this now rather than later.** #254 added it
as an eighth flat entry sharing `catalog:read` with Products, which is the second section in a
row whose only available place was "at the end of the list". A flat list stops being a list at
about this length; a group is what says Media belongs beside Products rather than beside API
keys.

## The addresses move with the screens

API keys leaves `/api-keys` for `/developer/api-keys`. A group whose members sit at unrelated
top-level addresses is a group in the sidebar and nowhere else — the address is the thing a
Merchant sends a colleague and a refresh lands on, so it is where the grouping has to be true if
it is true anywhere.

**`/developer/playground` rather than `/developer/api`**, and the reason is legibility rather than
correctness. `/developer/api` is a bare string prefix of `/developer/api-keys`, and `sectionOf`
would still get it right — it matches `pathname === section.path` or `${section.path}/`, which is
the boundary rule that module already carries because `/admin` being a prefix of `/admin-ui` cost
this repository once. Surviving a collision by design is not a reason to author one: two sibling
entries a hyphen apart are harder for a person to read than for the router, and *Playground* is
the word `CONTEXT.md` defines for what the screen does.

**`/developer/playground` carries more than a screen name.** The composed request lives in the
address — see
[ADR-0081](./0081-the-playground-attaches-its-credential-and-omits-the-ambient-one.md), which has
why — so that address is both where a Developer resumes after a re-sign-in and what they send a
colleague to reproduce a call.

**No redirect is left behind at `/api-keys`.** kobai is not published —
`tests/publish-guard.test.ts` holds that as a decision nobody has taken — so no Project exists
outside this repository and there is no bookmark to preserve. A redirect would be permanent
furniture in vendored source that `kobai-upgrade` can never reach
([ADR-0035](./0035-upgrading-is-a-command-kobai-ships.md)), paid forever to migrate nobody. After
the first publish this answer changes, and
[ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md) is the record that
says when.

## Considered and rejected

- **A second SPA at a second path.** Isolates nothing, for the cookie reason above, and pays every
  cost in the section before it.
- **A second app at a second origin.** The only shape that genuinely isolates, and it needs CORS
  and gets no session ever. It is the right architecture for a tool that does not need `/admin`,
  and this one does.
- **Signing into the playground as a different Merchant.** Makes it worse rather than better: one
  origin has one cookie jar, so signing in there *replaces* the session in the tab the Merchant
  is working in.
- **A flat `Developer` entry beside the other six.** Cheaper, and it means one screen, which means
  tabs inside it, which means an address a refresh does not land on — against the frame's own rule
  that every list and every state is somewhere you can send.
- **Link out to a documentation site.** kobai has none. A link to a page that 404s is worse than
  no link.
- **Vendor kobai's own prose docs into the Admin.** They age into lies at the first `kobai-upgrade`,
  and `docs/extension-points.md` is already the Developer's copy in the repository they own.
- **A CLI instead — `kobai api …`.** *Deferred rather than refused*, and it is a good idea: a
  terminal is where a Developer's credentials already live, which makes it the one place the
  isolation this record could not deliver is free. It is a different deliverable for a different
  beneficiary and does not ride in on this one.

## Consequences

- **Every generated Project inherits three more screens**, forever, under
  [ADR-0033](./0033-the-admins-shape-a-vendored-vite-spa-at-a-path.md)'s vendoring. That is the
  real price of this record and it is paid by the Developer, not by kobai.
- **The browser seam's sidebar cases change**, including the narrow-window one, because what is
  offered is what they assert.
- **#71's navigation half has an answer.** A Plugin-contributed screen now has a group to be
  contributed *into*, rather than a flat list to renegotiate. Whether Plugins may contribute UI at
  all is still #71's question and is untouched here.
- **`api-key:read` still gates API keys.** The screen moved; its Permission did not, and a Role
  that could see it before sees it in its new place.
