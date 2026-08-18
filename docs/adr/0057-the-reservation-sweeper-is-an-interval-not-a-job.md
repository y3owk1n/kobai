# The Reservation sweeper is an interval, not a job

Releasing lapsed Reservation holds runs on a **plain `setInterval` inside the application
process**, started by the Project after its migrations (`kobai.startSweeper()`), and not on
ADR-0026's Postgres-backed queue — which does not exist yet. The same pass deletes expired
`core_idempotency_key` rows, because they are the same shape of work and a second timer would be
a second answer to "what does kobai do periodically".

This **amends ADR-0026 in part**. That ADR's "background work runs on a Postgres-backed queue"
stands as the decision for background *work*; what this records is that kobai's first periodic
work arrived before the queue did, and that it was allowed to.

## Why not wait for the queue

Holds are the reason there is anything to sweep. ADR-0027 put them in — a platform meeting flash
sales cannot say "we oversell under contention" — and a hold with a TTL and nothing that acts on
the TTL is worse than no hold at all: a placement whose process dies between claiming stock and
Capture keeps that stock unsellable forever. So the sweeper ships with the holds or the holds do
not ship.

The queue is a larger decision than this needs. A job has a retry policy, a visibility window, a
failure record, a worker lifecycle and a story about what happens when two workers take the same
row — all of which ADR-0026 promises and none of which has been specified. A sweep is one
statement on a timer whose entire failure mode is *it happens a minute later*, and whose
correctness rests on the same `update … where released_at is null … returning` that makes a
compensation and a sweep safe to race in the first place. Building the queue in order to run it
would be paying for the general mechanism to get the trivial case.

## Considered options

- **Wait for ADR-0026's queue.** Rejected: it blocks holds behind a spec nobody has written, and
  holds are what stop the Store overselling.
- **A `pg_cron` job, or an external scheduler.** Rejected: both add a deployment dependency to a
  product whose stated goal is `docker compose up` with Postgres, the app and a volume — the
  thing ADR-0026 itself refused Redis over.
- **Sweep opportunistically, on the placement path.** Rejected: it makes a Shopper's request pay
  for other Shoppers' abandoned attempts, and a Store nobody is buying from — which is exactly
  when holds are stalest — would never sweep at all.

## Consequences

**kobai's first background work runs outside the job mechanism, and the queue spec will have to
migrate it.** That is the accepted cost, recorded in #98 when the trade was made. The migration
is small by construction: `sweepExpired` is one function over the database, so the queue's job is
to call it on a schedule the queue owns.

**Two instances sweeping is safe and was never a special case.** The releasing `update` claims
the rows it is about to act on and reports which ones it actually claimed, so a second sweeper —
or a Step's compensation racing one — releases nothing and returns nothing. Nothing here needs a
lock, which is also why a queue's visibility window buys nothing.

**It is explicit rather than automatic.** `createKobai` does not start it: the sweep reads tables
that exist only after `migrate()`, and a Project whose platform migrates elsewhere decides for
itself when that is true. A deployment that never calls it is untidy rather than broken — holds
from dead placements stay claimed and the idempotency table grows — which is the right failure
for something a Project has to opt into.

**A failure is logged, never thrown.** It runs on a timer with nobody to catch it, and an
unhandled rejection ends a Node process: a Store that stopped serving because it could not tidy
up would be a far worse outcome than the untidiness.
