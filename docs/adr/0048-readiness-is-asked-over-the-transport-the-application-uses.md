# Readiness is asked over the transport the application uses, and waiting is not migrating

Two decisions, taken together because they are two halves of one defect (#80).

- **The `db` healthcheck probes TCP, not the unix socket.** `pg_isready -h 127.0.0.1 …` in
  both `compose.yaml` files, plus a `start_period` so a slow first boot is not counted as a
  failing one.
- **Core waits for the database as a separate call from migrating it.**
  `kobai.waitForDatabase()` is bounded and retried; `kobai.migrate()` is neither, and never
  retries a migration that ran and failed. The reference Project calls them in that order and
  refuses to start on either, naming which.

## What was actually wrong

The generated Project's `app` service already declared
`depends_on: db: condition: service_healthy`, so the wiring was never the fault. The
**question the healthcheck asked** was.

`pg_isready` with no `-h` dials the unix socket. The official Postgres image initialises a
fresh volume by starting a *temporary* server on that socket — `docker-entrypoint.sh` starts
it with `listen_addresses=''`, deliberately, so nothing outside the container can reach a
database that is still being built — running its init scripts against it, shutting it down,
and only then starting the real server. Throughout that window a socket probe answers
**"accepting connections"** while nothing is listening on TCP at all.

Measured on an idle machine, probing both transports every ~120ms through `docker exec`:

```
t+1s socket_rc=2 tcp_rc=2
t+1s socket_rc=0 tcp_rc=2   ← healthy, by the old healthcheck's reckoning
t+1s socket_rc=1 tcp_rc=2   ← the temporary server, shutting down
t+1s socket_rc=2 tcp_rc=2
t+1s socket_rc=2 tcp_rc=0   ← the database a client can actually use
```

So compose declared `db` healthy, released `app` against a server about to be restarted, and
`app` died on `CREATE SCHEMA IF NOT EXISTS "drizzle"`. That refusal is
[ADR-0031](./0031-the-runtime-shape-devbox-a-pnpm-workspace-hono-and-one-gate.md) and #2's
deliberate behaviour working *correctly* — a failed migration means the application refuses
to serve rather than serving against a half-migrated schema — which is exactly what made this
so expensive to see. **The symptom was a correct refusal caused by an incorrect assumption
about readiness.** Six agents hit it across six tickets, and none could reproduce it alone:
the window above is a fraction of a second on an idle machine and the healthcheck's interval
is one second, so it takes a contended Docker to widen the window enough to be sampled.

`-h 127.0.0.1` asks the question `app` actually has — *is Postgres listening where I am about
to dial?* — and the whole init sequence answers no.

### What was run to believe it

An idle machine is the one place this defect hides, so the fix was exercised where it does
not. Alongside a background loop churning six Postgres containers through `initdb` on fresh
volumes, and four other checkouts' databases already running:

- `tests/a-project-boots-from-its-own-compose-file.test.ts` **six times**, and **three
  instances of it simultaneously** — the "three worktrees competing for Docker" condition the
  ticket names as what it took to see the failure at all. All green.
- `devbox run ci` end to end: 44 files, 426 tests.

The deterministic test below is the part that will still be true next year, when nobody
remembers to load the machine.

## Why a `start_period` as well

`interval: 1s` with `retries: 30` gives a fresh volume thirty seconds to initialise before the
container is declared **unhealthy**, which is a state `depends_on` never recovers from. That
is generous on an idle machine and not obviously generous on a loaded one, and the failure it
produces — "dependency failed to start" — reads nothing like "your laptop was busy".
`start_period: 60s` excuses failures during startup instead of counting them, and takes a
success inside the period at once, so it costs a healthy boot nothing.

## Why Core waits too, and why that is not the same as retrying a migration

The compose fix is the real fix for a Developer, and it covers nobody else. kobai is a
library; a Project deployed somewhere that starts containers in whatever order it likes gets
no `depends_on`, and "the database is a few seconds behind the application" is ordinary there
rather than exceptional.

But the stronger reason is that **Core could not tell the two failures apart**, and the ticket
was right to ask that they stay distinguishable — they were not. `migrate()` reaches for the
database on its first statement, so a Postgres that had not finished starting came back as:

```
{ ok: false, set: "core", message: 'Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"' }
```

Core's migration set named as the thing that failed, when nothing had been run at all, and
`/health` reporting `error` for an instance that would have worked a second later. A true
refusal with a false reason is the harder half to notice and the expensive half to debug.

So they are two calls, and what keeps them apart is that structure rather than a string:

| | waiting | migrating |
| --- | --- | --- |
| Retried | yes, until a deadline | **never** |
| Reports | `DatabaseReadiness` | `MigrationOutcome` |
| `/health` while it runs | `booting`, `{ status: "pending" }` | `booting`, `{ status: "running" }` |
| `/health` when it fails | the process exits; nothing has migrated | `error`, `{ status: "failed", set }` |

`/health` therefore says `error` only when a migration really did fail. That is the property
#2 built the endpoint for, and a retry loop *inside* `migrate()` would have blurred it — a
migration that ran, failed, and was tried again is exactly the half-migrated schema ADR-0031
refuses to serve against. Nothing here retries one.

### What waiting will not fix, it does not wait for

Only errors that mean *not yet* are retried: a socket with nothing listening on it, a name
with no address yet, and Postgres's own `57P03` (`cannot_connect_now`), which is what both
"the database system is starting up" and "…is shutting down" arrive as. A password Postgres
rejects, a database that does not exist, a `pg_hba` refusal — those are broken deployments
rather than slow ones, and they fail on the first attempt. Retrying them would buy nothing and
would delay the only useful response, which is saying so. An error carrying no recognisable
code is treated as fatal too: something unrecognised is likelier to be a deployment that will
never work than a database that is a second late, and the loud guess is the cheap one.

The deadline is 30 seconds by default. It is a backstop, not the mechanism — on a Developer's
machine the healthcheck above means the first attempt succeeds — so it is set to fail loudly
rather than to outlast anything. A platform that restarts a container is a faster path back to
a working deployment than a process that blocks indefinitely, and blocking would leave the
container neither serving nor saying why.

## Consequences

- `Kobai` gains one method, `waitForDatabase(options?)`, and `@kobai/core` two types. A
  Project that does not call it behaves exactly as before; the generated Project calls it.
- **`/health`'s shape does not change.** Waiting is not a migration lifecycle event and does
  not appear in `MigrationState` — putting it there would be the blur this ADR exists to
  avoid. A boot waiting on its database reports `booting`, which is what it is doing.
- Both compose files carry the fix. They are not generated from each other — only
  `packages/create-kobai/template/` is generated, from `reference/` — so
  `tests/the-database-is-ready-before-the-app-starts.test.ts` holds them to asking their
  databases the same question.
- That test pins a container mid-initialisation with an init script that never returns, and
  runs the healthcheck **taken out of the compose file** against it. Reading the file and
  asserting on flags would prove nothing: the old command and the new one differ by one, and
  the difference exists only for a Postgres that is still starting.
