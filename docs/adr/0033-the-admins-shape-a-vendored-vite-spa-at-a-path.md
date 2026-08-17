# The Admin's shape: a vendored Vite SPA, built into the Project and served at a path

ADR-0010 decided that the Admin ships in the Project's container, is served by the Project's
own process, and consumes only the public API. It named no framework, no bundler, no path
and no dev loop, and the first line of Admin code fixes all four. This records them, because
a frontend toolchain is a real addition to the runtime shape ADR-0031 wrote down.

- **React on Vite**, with **Tailwind CSS v4** and **shadcn/ui on Base UI**.
- **The source is vendored** into the Project at `reference/admin/` — a directory a
  Developer edits, not a package they depend on.
- **The Project serves the built files at `/admin-ui`**, from the same process and the same
  origin as the API. There is no CORS configuration anywhere in this repository.
- **The dev loop is a Vite dev server that proxies the API**, so the browser sees one origin
  while editing too.
- `devbox run ci` picks all of it up with no edit, because the Admin is a workspace package
  with a `build` and a `typecheck` script — which is exactly the consequence ADR-0031
  recorded.

## Why shadcn/ui, and why that is the same decision as "vendored"

ADR-0010's third constraint is that a Developer can change a component and never hear from
upstream about it. Most component libraries make that the hard case: the component is behind
a package boundary, and changing it means a wrapper, a theme escape hatch, or a fork.

shadcn/ui inverts it. `shadcn add button` **copies source into the project** — it is not a
dependency that renders a button, it is a file that does, and the file is ours from the
moment it lands. So "vendored" is not something this repository arranges around the
component library; it is what the component library already is. `reference/admin/src/components/ui/`
is ordinary Project source: Biome formats it, `tsc` checks it, and editing it is editing a
file rather than defeating an abstraction.

**Base UI rather than Radix.** Base UI became the CLI's default in its July 2026 change, and
the setup was taken from shadcn's own documentation rather than from memory: `shadcn init -b
base -p nova` writes `"style": "base-nova"` into `components.json` and installs
`@base-ui/react`, and the vendored components import from it (`@base-ui/react/separator`,
`@base-ui/react/button`). Radix is not deprecated and both ship every component; the choice
is recorded here so it is a decision rather than whatever the CLI defaulted to on the day.

Adding a component later is `pnpm --filter kobai-reference-admin exec pnpm dlx shadcn@latest add <name>`.
The CLI writes new component dependencies into `dependencies`; they belong in
`devDependencies`, for the reason in the next section.

## Why the whole toolchain is a devDependency

`vite build` inlines React, Base UI, Tailwind's output and the Geist font files into
`reference/admin/dist`, which is 384 KB. Nothing in that list is required by the Node process
at runtime — it serves bytes — so declaring every one of them a dev dependency is the honest
description as well as the one that lets an image drop them.

The one dependency that is *not* dev is `kobai-reference-admin` itself, in
`reference/package.json`: the server resolves the built assets through it at runtime.

**This now makes the image smaller, which it did not when this ADR was written.** The
separate, older bug it recorded was that both Dockerfiles' runtime stages copied the build
stage's whole tree — `node_modules` and all — and then ran `pnpm install --prod` over it,
which **relinks rather than prunes**: the symlink farm is rewritten and `node_modules/.pnpm`,
holding every devDependency's bytes, stays exactly where it was. `drizzle-kit`, `vitest`,
`biome` and `typescript` shipped for that reason, and the frontend toolchain joined them.

#12 fixed it, and the shape of the fix is worth knowing because the obvious version does not
work. The store is deleted and re-installed `--prod` **in the build stage**, before anything
is copied out of it — a `rm -rf` in the runtime stage, after the `COPY`, hides the bytes in a
lower layer and leaves the image exactly as large. The root image went from 933 MB to 270 MB
on arm64, `/repo` from 513 MB to 36 MB, and `tests/the-image-ships-no-devdependencies.test.ts`
inspects the built image rather than the Dockerfile.

## Why `/admin-ui`, and why not under `/admin`

The Admin's path is the Project's to choose — Core chooses none — and this one is chosen
against two constraints.

**It must not collide with the API.** `/admin/products` is a route; a SPA at `/admin` would
have to distinguish its own client-side routes from kobai's, and the first new API route
would break whichever it guessed. A separate path means the Project's router asks one
question — is this the Admin's? — and hands everything else to kobai untouched.

**It must not be inside the session cookie's scope.** The session cookie carries no `Path`
of its own and gets RFC 6265's default-path, which is the directory of the URI that set it —
`/admin` when Core is at the root (ADR-0032). Path-match requires a `/` boundary, and
`/admin` is not a prefix of `/admin-ui` at one, so **no asset request ever carries the
credential.** That is the same argument the cookie itself makes: a value that never reaches a
handler is a value that handler cannot log. Serving the Admin under `/admin` would have been
allowed and would have sent a live session with every JavaScript chunk.

The cost is one trap, and it is written down where it bites: `/admin` *is* a string prefix of
`/admin-ui`, so anything matching by bare prefix rather than by path boundary gets this
wrong. The Vite dev server's proxy is configured with regular expressions for exactly that
reason, and `reference/src/app.test.ts` asserts the server's own boundary in both directions.

## Why the process serves the files itself

`reference/src/admin-assets.ts` reads a directory and answers with bytes: about a hundred
lines, no dependency, and no second process. A static file server, a CDN or an nginx in front
would each be a second thing to deploy, which is the thing ADR-0010 spent the single
container to avoid.

Two details are load-bearing:

- **The assets are found through Node's module resolver**, not by counting `..` from the
  module. This file runs from `src/` under `--watch` and from `dist/src/` in the container,
  which are different depths — a relative path that is right in one is silently wrong in the
  other. `import.meta.resolve("kobai-reference-admin/package.json")` is right in both, and in
  the image, because it is the same lookup an `import` would do.
- **A missing fingerprinted asset is a 404, and every other unmatched path is `index.html`.**
  Deep links into the Admin work; a stale deploy says so instead of serving HTML into a
  `<script>` tag.

## Why the dev loop proxies rather than adding an origin

Editing the Admin needs a reload loop, which the Project's process does not have. The obvious
arrangement — Vite on 5173, API on 3000 — is two origins, and two origins need CORS, which is
the one thing ADR-0010 bought by spending a container.

So `devbox run admin:dev` runs Vite and **proxies `/admin`, `/store` and `/health` to the
Project**. The browser talks to one origin, exactly as it does in production; the session
cookie is set on that origin and sent back to it; there is nothing to configure and no
dev-only code path in the Admin. `devbox run dev` on its own still serves the *built* Admin
at `/admin-ui`, because it builds first — the Vite server is for editing, not for running.

## Consequences

- **The gate is slower by a bundle.** `devbox run ci` now runs `vite build`; it is a few
  hundred milliseconds and it is the same build the Dockerfile runs.
- **`biome.json` excludes one file, and cannot say why in itself.** Tailwind v4's entry
  stylesheet uses `@theme`, `@custom-variant` and `@apply`, which Biome's CSS parser reports
  as syntax errors, so `reference/admin/src/index.css` is excluded from the linter. The
  reason is here rather than in the config because **a comment in `biome.json` breaks
  Biome**: it stops parsing its own config, walks up, and fails with "found a nested root
  configuration". `biome.json` therefore stays comment-free despite `json.parser.allowComments`
  being set for everything else.
- **Node and browser TypeScript are checked under different configs.** The Admin's
  `tsconfig.json` replaces the base config's Node module settings with `bundler` resolution
  and `react-jsx`, and repeats the one workspace path mapping it uses. Two configs disagreeing
  is a real cost; one config that is wrong for half the repository is a worse one.
- **The Admin has no test seam of its own**, which #10 decided and this does not revisit.
  Interaction and visual testing are deferred. What is *not* deferred is the claim that the
  Admin uses only the public API: `tests/admin-uses-only-the-public-api.test.ts` fails the
  build on any network call outside the generated client, and on any kobai path the published
  description does not carry.
- **A Project that mounts Core under a prefix has one line to change.** The Admin builds its
  client against `window.location.origin`, because this Project binds Core at the root. Hono
  strips a mount prefix before Core sees a request, so the browser is the only party that
  knows the URI it asked for — nothing can derive this server-side.
- **`create-kobai` has a directory to copy.** When scaffolding is built, `reference/admin/`
  is the vendored tree a generated Project receives, and this ADR is what says why it arrives
  as source rather than as a dependency.
