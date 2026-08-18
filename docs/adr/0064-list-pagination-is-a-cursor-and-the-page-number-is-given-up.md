# List pagination is a cursor, and the page number is given up

Every list route on kobai's HTTP surface takes `?limit=` and `?after=`, and answers with an
**opaque** `nextCursor` beside its items. No route takes `?offset=`, and no route reports a
total. There are therefore no numbered pages anywhere in kobai, in the Admin or in anything a
Developer builds.

This is a decision about Core's promised surface rather than about the Admin. It affects a
Developer building a storefront who will never open the Admin, which is why it is recorded apart
from [ADR-0063](./0063-the-admins-frame-is-conventional-because-a-developer-inherits-it.md).

## What is decided

- **`?limit=`** — how many, with a default and a ceiling Core chooses. A request over the
  ceiling is refused rather than silently clamped, because a client that asked for 5,000 and got
  100 will read the short page as the end of the list.
- **`?after=`** — an opaque cursor from a previous response. Not an id, not a timestamp, and not
  documented as either.
- **`nextCursor`** in the envelope, absent when there is no further page. Its absence is the
  end-of-list signal; a short page is not, because a filtered page can be short and not last.
- **Every list route**, uniformly — `GET /admin/products`, `GET /admin/orders`,
  `GET /admin/api-keys`, and the merchant and role lists that do not exist yet. A surface where
  some lists page and others do not is one a client has to learn twice.

Today none of them takes any parameter at all: `ProductList` is `{ products: [] }` and
`OrderList` is `{ orders: [] }`, and both return everything there is.

## Offset pagination shows the same Order twice

**This is the whole argument, and it is not a performance argument.**

`limit`/`offset` is evaluated against the table as it is at the moment each page is fetched. Rows
inserted between page 1 and page 2 shift everything down by their count, so a row that was at
the bottom of page 1 is at the top of page 2 and is **shown twice** — and under a `desc` sort,
which is what every one of these lists wants, a row inserted during paging pushes one off the
bottom of page 1 and it is **never shown at all**.

kobai's Orders table is the one guaranteed both to grow without bound and to take concurrent
inserts, from every `POST /store/orders` a storefront makes. A Merchant paging through Orders
during a busy hour is the ordinary case, not the pathological one. The failure needs no
contention to reproduce, produces no error, and is invisible in every test that seeds a fixed
number of rows and then reads them back — which is every test that would be written for it.

That is the class of quiet wrongness this repository has repeatedly chosen against.
[ADR-0018](./0018-one-reservation-model-implemented-without-holds.md) refuses a `select`
followed by an `update` on exactly these grounds — the Store oversells and has "merely
implemented the appearance of safety, which is worse than none".
[ADR-0030](./0030-generate-and-migrate-only-never-drizzle-kit-push.md) refuses `drizzle-kit
push` because it reports success while dropping tables. A pagination scheme that silently
skips a Merchant's Order belongs in that company.

**A keyset cursor is evaluated against the row, not the position.** `where (created_at, id) <
(:after)` returns what follows *that record*, whatever has been inserted since. Rows are neither
skipped nor repeated, and the query stays on an index rather than counting past `offset` rows to
throw them away.

**The order must not be able to tie**, and this repository has already learned that once: #132
gave `readFulfilmentsOf` an `order by` ending in `id` because a tie made the upgrade gate's byte
comparison red *sometimes*. A cursor over a non-unique sort key is the same defect with a worse
symptom — a tie at a page boundary skips or repeats rows rather than reordering them. Every
paged query therefore ends its ordering in `id`.

## What is given up, and it is real

**No page numbers.** "Page 3 of 12" cannot be built from a cursor, and neither can jumping to
the last page. The Admin gets next/prev, and so does anything a Developer builds.

**No total.** `nextCursor` says whether there is more, not how much more. A count is a second
query over the whole table, it is wrong by the time it is rendered on exactly the tables that
matter, and offering one would put the expensive answer on the cheap path.

Both were weighed and neither is worth a list that lies. If a total is genuinely wanted later it
can arrive as its own route or its own field — additive, and a decision taken on its own terms
rather than smuggled in as a consequence of this one.

**Considered and rejected: both schemes**, offset for small lists and cursor for Orders. Two
contracts to keep correct forever, two shapes for a client to handle, and the boundary between
them is a judgement about table size that nothing enforces and that changes under a deployment
without anybody deciding it.

**Considered and rejected: a transparent cursor** — a documented `(createdAt, id)` pair a client
could construct. It is friendlier, and it promises the sort key and the tiebreaker under
[ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md) forever.
An opaque string keeps the ordering an implementation detail, which is the point of having one.

## Why this is decided now rather than when a list gets long

Because it is free now and never again.

ADR-0060 puts the paths, the fields a request accepts, the fields a response carries and the
`reason` inside a refusal under Core's semver commitment. Pagination parameters and a list
envelope are all four.
[ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md) is the licence
that makes changing them free today, and
[ADR-0061](./0061-what-the-first-publish-owes.md) is the list of everything that falls due when
that licence expires at the first publish.

After it, moving from offset to cursor is a **major** — a new parameter, a changed envelope, and
every client's paging loop rewritten. Taking it now costs a schema and an index.

## Consequences

- **The envelope grows a field, which is additive.** `{ products: [] }` becomes
  `{ products: [], nextCursor?: … }`; a client reading `products` is unaffected. The *parameters*
  are additive too — a caller that sends none gets the first page under the default limit rather
  than an error — so shipping this breaks nothing that exists, and the reason to do it before
  the first publish is what it costs to *change* afterwards, not what it costs to add.
- **Default page size is a promise.** A caller that sends no `limit` gets one, and changing it
  later changes what an existing client receives. It belongs in the route's description.
- **The Admin puts the cursor in the URL.** That is ADR-0063's business rather than this
  record's, but it is the reason a real router was worth taking: a page becomes linkable and the
  browser's back button becomes correct, which infinite scroll gives up and which an admin tool
  should not.
- **`GET /admin/products` is the one to look at first.** It returns each Product with its
  Variants, their Prices and their Inventory nested — so the row count understates the work by a
  lot, and it is the list where an unbounded response hurts before Orders do.
- **This says nothing about filtering, sorting or search**, all of which these routes also lack.
  They are additive after the fact in a way the pagination scheme is not, which is exactly why
  this one had to be settled first.
