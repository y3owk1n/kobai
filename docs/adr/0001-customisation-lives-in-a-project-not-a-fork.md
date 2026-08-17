# Customisation lives in a scaffolded Project, not a fork

kobai's original premise was that a Developer maintains a fork, with a "source control
base" and an "override control base" kept separate so upstream merges never touch
customisation. We rejected the fork. Instead, scaffolding generates a **Project** the
Developer owns outright and commits to their own repository, and **Core** is a versioned
dependency of it — so customisation and upstream never share a file, and upgrading is a
version bump plus shipped codemods rather than a merge.

## Considered options

- **Fork with an override layer** — the original proposal. Real prior art: Magento's
  `vendor/` vs `app/code`, Odoo module inheritance, Spree decorators and Deface, Yocto
  `.bbappend`. Rejected because upgrade pain is the loudest complaint in every one of
  those ecosystems, and Magento 1→2 stranded its entire plugin ecosystem doing exactly
  this. It also contradicts kobai's stated goal of best-in-market DX: a merge conflict is
  strictly worse than a compile error because it fails silently.
- **Pure plugin/dependency, Developer owns no shell** — Medusa and Vendure. Rejected as
  too restrictive for the agency segment kobai targets, who need to reach deeper than a
  plugin API allows.
- **Vendored source, copied in and owned forever** — the shadcn model. Rejected for Core
  (no upgrade path at all) but **retained for the Admin UI layer**, where "change this
  component and never hear from upstream again" is the actual desire and there is no
  runtime contract to break.

## Consequences

The fork was a symptom, not a mechanism. Overrides merge cleanly only when they attach to
a stable declared surface — and if that surface is stable, a versioned dependency does the
job without a fork; if it isn't, a fork doesn't save you either. So this decision moves the
hard work rather than removing it: kobai now has to **define an extension surface and
promise stability on it**. That promise, and its limits, is the central design problem of
the project.
