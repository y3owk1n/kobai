# A linked worktree seeds its own `.env`

The default ports are ordinary constants — `compose.yaml` publishes
`${POSTGRES_PORT:-55432}` and `${PORT:-3000}`, `.env` overrides them, and that is the whole
story in a normal checkout. **When a command runs in a linked git worktree and no `.env`
exists**, `scripts/ensure-env.ts` copies `.env.example` to `.env` with `POSTGRES_PORT` and
`PORT` filled in from a hash of the worktree's path. It writes parts, never assembled URLs,
and never over a file that already exists.

This supersedes [ADR-0046](./0046-the-postgres-credentials-belong-to-dot-env-too.md)
entirely. Its subject — the `awk` `.env` reader and the two percent-encoders in
`devbox.json`'s `init_hook` — ceases to exist rather than moving: docker compose reads `.env`
natively and always did, and so does Node. The **rule** ADR-0046 established survives intact
and is restated below.

## Why not derive always, and why not never

Always-derive is what the repository did, and it was its most bespoke machinery: roughly
sixty lines of `awk` embedded in JSON string literals, four tests, a 181-line test-support
module whose entire job was shelling a devbox hook, and two ADRs. It bought correctness in a
case most contributors never hit, and it charged every contributor the cost of an unusual
checkout to get it. A port nobody can predict is also a port nobody can type.

Never-derive is what every other project does, and it is wrong here for a boring reason:
this repository is worked on through agent worktrees, sixteen of them live at the time of
writing, and a `.gitignore`d `.env` does not travel into a new one. Every fresh worktree
would collide on 55432 until somebody wrote a file by hand, and the failure — a container
belonging to a different branch, already up and healthy on the port you wanted — is the kind
that wastes an afternoon before it names itself.

So the ordinary case is ordinary, and the unusual case pays for itself.

## The predicate

`git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`. In a linked
worktree the first is `…/.git/worktrees/<name>` and the second is `…/.git`; in a main
checkout both are `.git`. Two lines, deterministic, no I/O beyond git.

Rejected: **"a worktree, or the default port is already bound."** It recovers the
second-clone case below, and it makes the port depend on what else happens to be running —
so two runs of the same command in the same directory can land differently, which is the
class of bug nobody can reproduce.

## Why it seeds a file rather than exporting variables

This is the part worth keeping. The old hook exported the derived values into each script's
environment, so `pnpm run db` and a hand-typed `docker compose up db` in the same directory
brought up **two different stacks** — the script's derived port against `compose.yaml`'s
literal. That hazard already existed and nobody had been bitten badly enough to name it.

Conditional derivation makes it worse in one specific way: outside a worktree the scripts
and bare compose agree, so a contributor learns a rule that is false exactly where it
matters. Seeding a file removes it instead. Compose reads `.env` itself, so bare
`docker compose` and the scripts now agree — which they never did before — and the values
become legible: you `cat .env` rather than reasoning about a hash.

It also means the derivation runs **once**, at seed time, instead of in front of every
command, and `vitest.config.ts` reads `.env` like everything else rather than importing a
derivation module.

The seed is chained explicitly onto the scripts that need it — `"db": "node
scripts/ensure-env.ts && docker compose up -d --wait db"`, and likewise `up`, `dev` and
`test`. Not a root `postinstall`: `Dockerfile:11` runs `pnpm install --frozen-lockfile`
inside the image build, so a `postinstall` would fire there, consult git in a context that
may have neither `git` nor `.git`, and turn a wrong port into a broken image build. Not a
`pre*` script either — pnpm leaves `enable-pre-post-scripts` off by default, so one would
silently never run.

## Why it copies the whole of `.env.example`

Because a minimal file is a trap. If the seed wrote only the two derived lines, a
contributor who later wants a Stripe key does the documented thing — `cp .env.example .env`
— and silently destroys their worktree's ports, which is this decision's own failure
reintroduced by its own documentation. A whole copy means `.env` is the familiar file,
already complete, and nobody ever needs to overwrite it. It costs one read and a two-line
substitution.

## Parts, never URLs — ADR-0046's rule, restated

The seed writes `POSTGRES_PORT` and `PORT`. It does **not** write `DATABASE_URL` or
`KOBAI_TEST_DATABASE_URL`. Those are assembled at run time from `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB` and the port — by `vitest.config.ts` for the suite, and by
the reference Project's `dev` script for the host.

Writing whole URLs was tempting and is exactly #63 again: a contributor changes
`POSTGRES_PASSWORD` in `.env` and gets a container with the new password and two stale URLs
sitting three lines below it, with an authentication failure naming neither. One source
decides where the container comes up **and** who it lets in. That was ADR-0046's whole
point, and it is the half of it that survives.

**The encoding survives too, and keep the distinction.** `pg` reads the user and the
password with `decodeURIComponent` and the database name with `decodeURI`, and the second
never unescapes a reserved character — so an over-encoded `=` in a database name arrives as a
literal `%3D` and Postgres reports a database nobody named. Encode against the driver, not
against the RFC. This is now two `encodeURIComponent` calls and one `encodeURI` rather than
thirty lines of `awk`, but it is the same finding and it was expensive to make.

## What is given up

- **A second clone is not a worktree.** `~/Dev/kobai` and `~/Dev/kobai-2` both report "not a
  worktree" and both take 55432. The old path-hash covered this; the predicate does not.
  Accepted knowingly: it is rarer, and it is the collision every project has, with an
  answer — write a `.env` — that every developer already knows.
- **`COMPOSE_PROJECT_NAME` derivation is dropped.** Compose names a project after the
  directory's basename, and worktree basenames are already distinct, so the derived name was
  defending only the case of two clones both literally called `kobai` — which is the case
  above, already declined. Covering it here alone would be inconsistent. Anyone who wants a
  pinned project name sets it in `.env`, and the seeded copy carries the line commented out
  like every other.
- **55432 is not 5432, and that is unchanged.** `compose.yaml`'s reason for the offset never
  had anything to do with devbox: a Developer's own Postgres should not have to move. `PORT`
  defaults to the wholly conventional 3000.

## Consequences

- **`tests/support/init-hook.ts` is deleted**, and with it the arrangement where a rule had
  to be tested by shelling a config file. The derivation is a pure function taking a path
  and a worktree flag, so `tests/the-ports-belong-to-the-checkout.test.ts` becomes a small
  unit test over both branches with no subprocess. The 650-line credentials test reduces to
  "the suite dials the credentials the container was started with", plus the encoder's two
  cases.
- **`.env` is now a file some checkouts have without anyone creating it.** It is gitignored
  at every depth (`.gitignore` lines 2–4), so nothing reaches a commit or a build context —
  see [ADR-0068](./0068-gitignore-is-the-one-statement-of-what-a-checkout-generates.md) — but
  "the tool wrote my config" is a real surprise and it belongs in `.env.example`'s header and
  in AGENTS.md.
- **A generated Project ships none of this.** It is a fresh `git init` repository and can
  never be a linked worktree, so it takes 55432 and 3000 from its own `.env.example` and has
  no seed script, no derivation, and nothing conditional to explain — which is the right
  shape for the artifact
  [ADR-0001](./0001-customisation-lives-in-a-project-not-a-fork.md) says a Developer owns.
