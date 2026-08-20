# kobai

Open source headless commerce engine with a pre-built admin UI, built to be extended
without forking.

> **Status: walking skeleton in progress.** It boots, migrates, and a Merchant signs in to the
> Admin, creates a Product and sees the price a storefront would receive. See
> [`CONTEXT.md`](./CONTEXT.md) for the vocabulary and [`docs/adr/`](./docs/adr/) for the
> decisions made so far.

## Starting a Project

```sh
npm create kobai@latest my-store
cd my-store && docker compose up --build
```

That generates a git repository you own outright, commits it, and brings up Postgres and the
application on http://localhost:3000. **Node and Docker are the whole of what it needs** — a
Project ships no devbox and no toolchain of its own (ADR-0083), and every command it has is a
`package.json` script. kobai is an ordinary versioned dependency in its `package.json`, so upgrading is
a version bump rather than a merge — see
[ADR-0001](./docs/adr/0001-customisation-lives-in-a-project-not-a-fork.md). Everything you
customise is declared in one file, `kobai.config.ts`.

The Project you get is the one in [`reference/`](./reference), which is also the Project this
repository boots and tests on every commit ([ADR-0029](./docs/adr/0029-the-reference-project-is-the-release-gate-and-content-is-built-first.md));
`create-kobai` generates it rather than something adjacent to it, and the build fails if the
two drift.

## Running this repository

You need [devbox](https://www.jetify.com/devbox) and Docker. Nothing else — devbox brings
its own Node.

```sh
devbox run up     # Postgres and the application, and nothing else
```

That prints the URL it is serving on, because the port belongs to the checkout rather than to
kobai — it is derived from this directory's path, in the range 53000-53999, so a second clone
or a git worktree can serve at the same time without either being told about the other. Take
the address from what it printed:

```sh
curl localhost:53154/health
open http://localhost:53154/admin-ui/   # the Admin, from the same process and the same origin
```

Set `PORT` in the environment or in `.env` to pin one instead. The database's port works the
same way, in 55000-55999.

Migrations apply at boot, so a fresh database becomes a working Store with no separate step.
If they fail, the application exits rather than serving traffic against a half-migrated
schema — `/health` says which it is. `devbox run ci` is the gate: lint, typecheck, build and
the test suite.

**The Admin needs a Merchant, and the first one is seeded at boot** from
`KOBAI_INITIAL_MERCHANT_EMAIL` and `KOBAI_INITIAL_MERCHANT_PASSWORD` — see `.env.example`.
kobai has no unauthenticated write path, so there is deliberately no way to create that first
Merchant over HTTP: on a deployment holding none, nobody could hold the permission it would
need ([ADR-0041](./docs/adr/0041-the-first-merchant-is-seeded-at-boot.md)). A deployment
given neither variable still boots and says in its log that nobody can administer it.

## What it is

- **Headless.** kobai ships an API and an Admin. The storefront is yours — see
  [ADR-0002](./docs/adr/0002-headless-the-storefront-is-out-of-scope.md).
- **One thing to deploy.** The Admin is served by the Project's own process, at a path, from
  the same origin as the API, and uses only the public API — so there is no second service
  and no CORS to configure. Its source is vendored into the Project and yours to edit — see
  [ADR-0010](./docs/adr/0010-the-admin-ships-in-one-container-and-gets-no-private-api.md) and
  [ADR-0033](./docs/adr/0033-the-admins-shape-a-vendored-vite-spa-at-a-path.md).
- **Extended without forking.** Scaffolding generates a Project you own outright; kobai
  Core is a versioned dependency of it — see
  [ADR-0001](./docs/adr/0001-customisation-lives-in-a-project-not-a-fork.md).
- **Customised by replacing Workflow Steps.** Pricing, tax, shipping selection and
  fulfilment routing are declared processes whose individual steps you can swap — see
  [ADR-0003](./docs/adr/0003-the-extension-surface-and-what-we-promise.md).
- **Stable on five surfaces, and no more.** What is safe to depend on, what Core's semver
  does *not* cover, and which Extension Points are proven today rather than merely promised
  — see [the five Extension Points](./docs/extension-points.md).
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
