# A detached Media is still the Store's, and kobai deletes no bytes

#255 attached Media to a Product and to a Variant, and doing it forced a question neither
[ADR-0015](./0015-shopper-supplied-input-is-project-owned.md) nor
[ADR-0078](./0078-media-bytes-come-from-the-storage-and-kobais-own-route-is-open.md) had taken:
**what becomes of a Media that nothing references any more** — the row, and the bytes.

It is here rather than only in prose because it is the half that cannot be undone. A cascade
that has already deleted somebody's artwork is not a decision anybody gets to revisit, and a
`MediaStorage.remove` promised to implementers is permanent under
[ADR-0019](./0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md).

Decided:

1. **An unreferenced Media is an ordinary state, not garbage.** Detaching removes the
   attachment and nothing else; the row stays, the bytes stay, and `GET /admin/media` still
   lists it.
2. **kobai deletes no Media and no bytes, on any path.** There is no cascade, no sweep, no
   `DELETE /admin/media/{id}`, and `MediaStorage` still has no `remove`.
3. **A Media something is showing cannot be deleted out from under it**, and that is a
   `restrict` in the schema rather than a rule in a handler.

## An unreferenced Media is not garbage, because a Media was never a Product's

The tempting reading is that a detached image is litter: nothing points at it, so something
ought to collect it. That reading assumes a Media belongs to the thing it was attached to, and
it does not. `core_media` has been a Store-level record since #254 — uploaded at a route of its
own, listed at a route of its own, with no reference to a Product in either direction — and
#255 attaches it through a **join table** precisely so that one image can lead on two Products
at once.

Follow that through and "unreferenced" stops meaning anything durable:

- A Merchant uploads six photographs of a new range and attaches them over the following week.
  Every one of them is unreferenced the moment it arrives; five of them still are the next
  morning.
- A Merchant swaps the leading image on a Product for a better crop. The old one is now
  unreferenced, and is exactly the asset they will want back if the new crop turns out badly.
- A Product is deleted. Its attachments go with it by cascade, and its images do not — they are
  the Store's photographs of a thing it used to sell, and may already be attached elsewhere.

So a sweep of unreferenced Media is not a tidy-up, it is a scheduled deletion of a Merchant's
uploads that nobody asked for and nothing announced. **A Media library is a library.**

## Nothing deletes it, and the reason to be sure is that nothing can undo it

Deletion arrives in three shapes and all three are refused here.

**A cascade** — a Media going when the last thing showing it goes — is the one that reads as
tidy and is the worst of the three: it is triggered by an act aimed at something else entirely.
A Merchant deleting a discontinued Product would silently lose the photographs they paid for,
and no status code can un-say it. That is exactly
[ADR-0059](./0059-catalog-deletion-refuses-rather-than-cascading-or-releasing.md)'s house rule
— *a `DELETE` that removed a resource its caller never addressed is a worse thing for a route
to do than to refuse* — reached one table further out.

**A sweep** is the same deletion with a delay in front of it, and a worse failure mode: the
window between uploading and attaching is the ordinary working state above, so a sweeper's
correctness rests on a Merchant being quick.

**A route** — `DELETE /admin/media/{id}` — is the honest shape, and it is deliberately out of
scope. #255 gives a Merchant no way to delete an asset, so nothing here is a dead end: what a
Merchant can do is detach it, which is one field of a `PATCH` and is the whole of what the
ticket asked for. When that route is designed it inherits ADR-0059's rule from the schema
already — see below — and it is where the `remove` question gets settled.

**`MediaStorage` therefore still has no `remove`, and that is this record declining to add
one.** ADR-0078 left it out because "an operation every implementer must write and nothing ever
calls is a promise bought with somebody else's work", and named the ticket that would decide it
as *the one that gives a Merchant a way to delete an asset*. This is not that ticket. Adding
`remove` here would mean promising every substitute storage an operation whose only caller
would be a route nobody has designed.

**The cost is stated rather than hidden.** A Store that uploads and detaches a great deal
accumulates objects it is paying to store, with nothing in kobai to remove them. That is a bill
a Merchant can see and act on out of band — every object store has its own console and its own
lifecycle rules — and it is the cheaper of the two mistakes: unbounded storage is recoverable
by hand, and a deleted photograph is not.

## The `restrict` is ADR-0059's rule held by Postgres rather than by a handler

`core_product_media.media_id` and `core_variant_media.media_id` are both `on delete restrict`.
Since nothing on the surface deletes a Media, that constraint refuses nothing any request can
send today — which is what makes it worth putting in now rather than later. It does three
things:

- It states in the schema that a Media outlives an attachment rather than the other way round,
  where the `cascade` on the other column of the same row says the opposite about the Product.
  The pair is readable side by side.
- It stops a hand-run `DELETE` — ADR-0004's unmediated writer, the same one
  [ADR-0037](./0037-updated-at-is-a-trigger-because-core-does-not-mediate-every-write.md) puts
  `updated_at` in a trigger for — from leaving a Product showing a row that is not there.
- It makes the future delete route ADR-0059-shaped **by construction**: the first
  implementation that tries to delete an attached Media meets a foreign-key violation, which
  `violatesForeignKey` reads into a refusal exactly as `role-in-use` already is. And ADR-0059's
  own test of an acceptable refusal is met before that route is written: **the repair is one a
  Merchant can carry out themselves**, by detaching the image, which is a control that exists.

Adding the constraint later would have been a migration onto a table that might already hold
rows a `restrict` would have prevented.

## What was rejected

- **Cascade from the last attachment.** Above: a deletion triggered by an act aimed at
  something else, of a thing that was never that thing's to own.
- **A sweeper for unreferenced Media**, beside the Reservation and idempotency-key sweep of
  [ADR-0057](./0057-the-reservation-sweeper-is-an-interval-not-a-job.md). Those two release
  claims kobai itself took and expire keys kobai itself minted, on windows kobai defines; this
  would delete a Merchant's file on a timer, and the state it treats as garbage is the ordinary
  state of an image between being uploaded and being attached.
- **A `deletedAt` on `core_media`, or an `unreferenced` flag.** Both are answers to a question
  nothing asks: there is no route that hides a Media and no screen that filters one, so the
  column would be a promise (ADR-0060) bought before anything needed it. `GET /admin/media`
  listing everything, newest first, is what a library is.
- **`MediaStorage.remove`.** Above, and ADR-0078's own reasoning: it belongs to the ticket that
  gives a Merchant a way to delete an asset, and until then it is an interface addition — a
  break for implementers, cheap only while
  [ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md)'s licence
  holds — with no caller.

## Consequences

- **Detaching is safe, and the description says so.** `PATCH /admin/products/{id}` and
  `PATCH /admin/variants/{id}` both say in prose that a Media left out of the list is detached
  and not deleted, because that is the sentence a Merchant needs before they will use the
  control at all.
- **A Store's storage bill is unbounded by kobai and bounded by its object store.** A
  deployment that cares wires a `MediaStorage` with a lifecycle rule of its own, which is one
  line of `kobai.config.ts` and is the case that interface was shaped for.
- **The delete route, when it arrives, is owed three things**: the refusal shape above (which
  the schema already produces), a decision about `MediaStorage.remove`, and — if `remove` is
  added — a sweep for the objects `uploadMedia` leaves behind when its insert fails, which
  `media/media.ts` already names as falling due at exactly that moment.
- **Nothing in this record constrains a Project.** A Developer whose deployment wants an
  aggressive lifecycle policy has one; ADR-0015 already puts a Shopper's uploaded artwork in
  the Project's own table, where the Project's own rules apply.
