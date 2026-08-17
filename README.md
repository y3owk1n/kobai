# kobai

Open source headless commerce engine with a pre-built admin UI, built to be extended
without forking.

> **Status: walking skeleton in progress.** It boots, migrates and serves a Store; the
> catalog, the Workflows and the Admin are being built on top of it. See
> [`CONTEXT.md`](./CONTEXT.md) for the vocabulary and [`docs/adr/`](./docs/adr/) for the
> decisions made so far.

## Running it

You need [devbox](https://www.jetify.com/devbox) and Docker. Nothing else — devbox brings
its own Node.

```sh
devbox run up     # Postgres and the application, and nothing else
curl localhost:3000/health
```

Migrations apply at boot, so a fresh database becomes a working Store with no separate step.
If they fail, the application exits rather than serving traffic against a half-migrated
schema — `/health` says which it is. `devbox run ci` is the gate: lint, typecheck, build and
the test suite.

## What it is

- **Headless.** kobai ships an API and an Admin. The storefront is yours — see
  [ADR-0002](./docs/adr/0002-headless-the-storefront-is-out-of-scope.md).
- **Extended without forking.** Scaffolding generates a Project you own outright; kobai
  Core is a versioned dependency of it — see
  [ADR-0001](./docs/adr/0001-customisation-lives-in-a-project-not-a-fork.md).
- **Customised by replacing Workflow Steps.** Pricing, tax, shipping selection and
  fulfilment routing are declared processes whose individual steps you can swap — see
  [ADR-0003](./docs/adr/0003-the-extension-surface-and-what-we-promise.md).
- **Deployed with Docker.** One Project, one container.

## Release target

kobai has **one release target — the platform in full**. There is no milestone split; "v1"
and "1.0" mean the same thing. See
[ADR-0024](./docs/adr/0024-one-release-target-v1-and-1-0-are-the-same-thing.md).

**kobai is a commerce-driven CMS.** The content platform — generic content types, blocks,
pages, drafts, localisation — ships as a first-party Plugin rather than in Core, which
makes it the hardest available proof that the extension surface is real. See
[ADR-0023](./docs/adr/0023-the-content-platform-is-a-first-party-plugin.md).

## What it is not

kobai ships no storefront
([ADR-0002](./docs/adr/0002-headless-the-storefront-is-out-of-scope.md)) and is not
multi-tenant
([ADR-0005](./docs/adr/0005-single-tenant-with-first-class-channels-and-regions.md)).

Core stays small on purpose: **it contains what every store needs and what cannot be a
Plugin, and nothing else** ([ADR-0028](./docs/adr/0028-the-core-membership-rule.md)).
Content, made-to-order production, bundles, subscriptions, gift cards, B2B, reviews and
advanced search are all first-party Plugins — that's how kobai ships capability without
growing the surface it has to keep stable.

## Licence

MIT. kobai is a project, not a business — there is no paid tier and no hosted offering
planned. See [ADR-0007](./docs/adr/0007-a-project-not-a-business-scoped-by-one-real-store.md).
