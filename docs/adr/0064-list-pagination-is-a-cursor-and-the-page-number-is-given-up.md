# List pagination is a cursor, and the page number is given up

> **"Every list route" is bounded by
> [ADR-0067](./0067-a-set-the-deployment-declares-is-not-a-list-route.md).** Everything below
> stands for a list over a **table**. A set the deployment declares in `kobai.config.ts` — today
> only `GET /admin/fulfilment-strategies` — answers in full and does not page, because nothing
> can be inserted into it between one page and the next, which is this record's entire argument.

> **Amended in the building (#176): "the Admin gets next/prev" understated what a cursor
> costs.** *Previous* cannot be built from a cursor either — an opaque cursor says what comes
> after a record and can say nothing about what came before it, which is not a gap in the
> implementation but the price of the opacity this record chose. `reference/admin/`'s
> `components/pager.tsx` therefore carries the cursors this browser has already been given in
> the **history entry's own state**, so following next three times and pressing back three
> times walks the same three pages in reverse. It is deliberately not in the URL beside the
> cursor: a link a Merchant sends would then carry a trail of somebody else's browsing, and it
> would grow without bound down a long list. The consequence is visible rather than hidden — a
> deep link into page three has no trail, so it offers **"First page"** rather than a
> "Previous" that would silently mean something else. Everything else here stands.

> **Amended in the building (#183): a cursor names the list that issued it, and is deliberately
> not signed.** What shipped in #171 carried a position and nothing else, so a cursor cut from
> `GET /admin/products` decoded on `GET /admin/orders` and was answered with a page of the wrong
> list. It now carries the list too and is refused anywhere else — as the existing `invalid` at
> 400, argued below. The *other* half of "opaque" was settled at the same time and the answer
> was no: see [A cursor names its own list, and is not signed](#a-cursor-names-its-own-list-and-is-not-signed).
> Everything else here stands.

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
- **`?after=`** — an opaque cursor from a previous response **of the same list**. Not an id, not
  a timestamp, and not documented as either. One from another list is refused rather than
  answered (#183, below).
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

## A cursor names its own list, and is not signed

Added by #183, which is where the sentence above — "not an id, not a timestamp, and not
documented as either" — was read back and found to be two claims rather than one.

### It names its own list

The payload is the list's name, then the position. `contract.pageQuery(<list>)` is what a route
names its list in, and that one call decides both ends: it is the schema that will *read* a
cursor and the name that reaches the reader, which is what `takePage` writes the *next* one
under. There is no second place to keep in step, so the two ends cannot come apart.

**The refusal is the existing `invalid` at 400, and that is the decision rather than the
default.** A `reason` of its own was weighed and declined. Under
[ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md) a new
`reason` is permanent, and an addition turns an exhaustive `switch` over a regenerated
`@kobai/client` into an incomplete one — a real cost, paid by every consumer. What it would buy
is a distinction no client can act on: "this is not a cursor" and "this is not *your* cursor"
both mean *stop sending this value*, and neither is recoverable by retrying. `invalid` is
already the word for a query parameter that does not fit the endpoint, and a cursor another list
issued is exactly that. The diagnosis a person needs is in the refusal's `error` string, which
names the list that would have had to issue it and is promised to nobody.

**What this is worth is narrow and worth stating.** It catches a client bug — a cursor kept in
the wrong variable, a URL pasted from another tab — and turns it from a 200 into a refusal. It
is not a security boundary and is not doing security work; see below.

### It is not signed

The other half of ADR-0064's claim is that base64url reverses in one command, so a client
*could* read the sort key and the tiebreaker this record exists to keep private. Signing the
cursor was considered and **declined**. Three reasons, and the first is the one that decides it:

- **A signature would defend nothing.** A cursor names a position, and every position it can
  name is inside a list the caller's credential already opens whole: these routes sit behind a
  Merchant session and a `…:read` Permission, and the answer to `after=<any position at all>` is
  a page of a list they were already reading. There is no row a forged cursor reaches that
  `?limit=` does not.
- **It would be kobai's first secret.** `kobai.config.ts` holds no key of any kind today. A
  signature means a new config surface and an ADR of its own, a decision about rotation, every
  instance behind a load balancer having to agree, and a Merchant's open page breaking the
  moment the key moves. That is a large, permanent obligation for the benefit above.
- **Obfuscating without a key would be worse than either.** It reads as protection, is none, and
  would still have to be undone the day a real key is wanted.

**What is genuinely at risk is coupling**, not disclosure: a client that unpicks a cursor starts
depending on the ordering. That is answered by saying so rather than by hiding it — the `after`
parameter's own description promises nothing about the contents and says to send it back as
received — and a client that reads past that is relying on internals kobai may change without a
major. The same bargain every undocumented shape offers.

**What would reopen this.** A cursor that carried something the caller must not choose for
themselves — a filter, a scope, a Store — because that is the first version of this where
forging one reaches a row rather than a position. Reopening it is a **wire-format change**, and
therefore a major once anything is published (ADR-0060,
[ADR-0061](./0061-what-the-first-publish-owes.md)); it is free before then, which is why #183
settled it now rather than leaving it to be rediscovered.

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
