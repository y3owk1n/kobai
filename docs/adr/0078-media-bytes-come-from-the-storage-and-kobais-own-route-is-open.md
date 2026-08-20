# Media bytes come from the storage, and kobai's own byte route is open

`MediaStorage` is ADR-0003's third Extension Point's third named interface (#254), and building
it forced two decisions that neither [ADR-0015](./0015-shopper-supplied-input-is-project-owned.md)
nor the spec had taken. Both are hard to reverse — one is a promised field's meaning and the
other is a route that no credential opens — so they are here rather than only in the prose a
Developer meets.

Decided:

1. **A Media's address is the storage's answer, asked at read time, and is never a column.**
2. **kobai serves bytes at one open route, `GET /media/{key}`, for the storage it ships**, and a
   storage that answers a URL of its own is never asked for a byte.
3. **Core ships a working implementation of this interface**, which is the opposite of what
   [ADR-0053](./0053-core-owns-the-payment-record-and-ships-no-provider.md) decided about
   `PaymentProvider`, for a reason that no longer applies.

## The address is asked for, not stored

`core_media` holds a **storage key** and nothing that looks like a URL. Every read calls
`MediaStorage.urlFor(key)` and puts the answer on the response.

The alternative — a `url` column written at upload — is cheaper on every read and wrong in
exactly the case this interface exists for. A Store that has been running on the shipped
filesystem storage and moves its objects to a bucket behind a CDN would find a table full of
addresses naming a service it no longer uses, and would need a data migration to finish a change
that is otherwise one line of `kobai.config.ts`. Asking makes that change complete: copy the
objects, change the line, and every Media ever recorded reports the new address.

What it costs is that `urlFor` is called once per row of a page, which is why it is
**synchronous and side-effect free** on the interface. A storage that had to call out to answer
would make listing Media an *n*-request operation. A signed URL with an expiry is still
expressible: it is computed from a key and a secret the storage already holds.

The field on the wire is therefore **absolute or root-relative**, and a client has to render
both. That is a promise under ADR-0060 and it is the honest one — a field that always pointed at
kobai could not later be made to point anywhere else without a break.

## kobai serves bytes, and only for the storage that has no address

Serving images through the application is the thing this design is trying not to do. A
`MediaStorage` fronted by a CDN should not have its own bytes proxied through a Node process,
and it is not: `urlFor` sends the storefront to the CDN and no byte reaches kobai.

But the storage Core ships writes **files under a directory**, and a file on a disk is reachable
over HTTP by nothing. Without a route of kobai's own, a deployment that configured nothing would
record Media it could not show — and "a Store with no object store still boots and still shows
images" is the whole of what shipping a default is for.

So `MediaStorage.read` is on the interface, and **answering `null` from it is an ordinary
answer** meaning *my bytes are not kobai's to serve*. A bucket's adapter writes
`read: async () => null` and is complete; `GET /media/{key}` answers `media-not-found` to anyone
who asks it anyway. It is a **required** member rather than an optional one deliberately: an
optional operation makes a substitute's completeness something you have to look up, where one
line returning `null` states the decision where somebody reads the object.

The route exists on every deployment whatever the configuration, because a description that
enumerated different paths per deployment would not be a contract — the same argument
`http/admin.ts` already makes about building a schema per instance.

## The route is open, and that is the part to be sure about

An `<img>` sends no credential. There is no header a browser can be talked into attaching to
one, so a route behind the store surface's bearer key would serve nothing to the thing it exists
for. The choice was therefore never *how* to gate this; it was whether kobai serves image bytes
at all, and the paragraph above is why it does.

The consequence is stated rather than mitigated: **everything the shipped storage holds is
readable by anyone who knows a key**, exactly as a public bucket's objects are. Three things
bound it:

- **Keys are unguessable.** `filesystemMediaStorage` names an object with a v4 UUID — 122 bits
  from the platform CSPRNG — and an extension taken from the content type. Nothing a caller sent
  is ever part of a path.
- **Nothing there enumerates.** The byte route answers one key at a time; `GET /admin/media` is
  the only listing and it is behind a Merchant session and `catalog:read`.
- **Media is Merchant-supplied catalog data by definition.** ADR-0015 puts a Shopper's uploaded
  artwork in the Project's own table precisely because that is *not* Media, so what this serves
  is what a storefront was going to publish.

A deployment holding assets that must not be public wires a storage that signs its own URLs and
serves nothing through kobai. That is one line, and it is the case the interface was shaped for.

`packages/core/src/http/openapi.test.ts` names the open operations in `OPEN_OPERATIONS` rather
than inferring them from an absent `security` block, so **a fourth entry there is a new open
route** and has to be argued rather than merely added.

## Core ships an implementation, and ADR-0053's reason not to has expired

ADR-0053 has Core implement `PaymentProvider` nowhere, and its argument is precise: dependency
substitution had one named interface, `Logger`, whose every implementation was Core's own — so a
second interface implemented only by Core would have reproduced #72's finding instead of closing
it.

[ADR-0051](./0051-the-commerce-spine-comes-before-the-content-plugin.md)'s spec closed it: the
reference Project's `manual` provider and `@kobai/plugin-stripe` are two implementations from
outside kobai, one from a Project's own source and one from a published package. Media therefore
does not have to be the proof, and the argument the other way is free to win: a Store with no
object store should boot and should show its images, and refusing to work until a Developer has
chosen a bucket is a worse default than a directory.

**This does not amend ADR-0053.** Nothing about `PaymentProvider` changes — Core still ships
none, and a deployment that wires none still refuses `place-order` alone. What is recorded here
is that the *reason* ADR-0053 gave for shipping nothing was about the state of the evidence in
2026, and that state has moved.

The default is local disk and says so where a Developer meets it: a deployment running two
containers has each of them holding half its images, and one with no volume mounted at the
directory loses them on the next deploy. Both are properties of local disk rather than of the
implementation, and the answer to either is to wire a storage that has neither.

## What was rejected

- **A `url` column.** Above: cheaper per read, and wrong exactly when a Store does the thing the
  interface exists to allow.
- **kobai proxying every storage's bytes.** It would put the application in front of the one part
  of a storefront somebody else has already solved, and — because the `url` is a promised field —
  it could not be undone later without a break.
- **The Project serving the filesystem storage's directory itself.** It works, and it makes
  kobai's default not work: a Developer who has not written that route has recorded Media
  nothing can show, and a colleague's second checkout is the same state again. ADR-0070's
  Project-mounted route is the precedent *against* this rather than for it — that one exists
  because a Plugin cannot mount a route and a bank's signature verification is genuinely the
  Project's to own, and neither is true of serving a PNG.
- **An optional `read`.** The one-line `null` is what makes a substitute's completeness readable
  at the object rather than in this record.
- **A `remove` operation, in this slice.** Nothing on the surface deletes Media yet, and an
  operation every implementer must write and nothing ever calls is a promise bought with somebody
  else's work. It is a decision for the ticket that gives a Merchant a way to delete an asset,
  and until the first publish
  [ADR-0058](./0058-a-promised-surface-may-be-broken-until-the-first-release.md) makes adding it
  cheap.

## Consequences

- **A client renders `url` and parses none of it.** Absolute or root-relative, both ordinary.
- **A deployment that changes storage moves its objects.** There is no `name` on the interface
  and nothing records which storage wrote a key, because there is one per deployment.
- **The bytes are served as the content type the *row* holds, with `X-Content-Type-Options:
  nosniff`.** The upload declared it and nothing since has been in a position to know better,
  and a browser guessing `text/html` about a file a Merchant uploaded would be a stored script
  on the Store's own origin.
- **The byte route sits behind the migration gate** and answers 503 before migrations apply,
  unlike `/health`: it reads `core_media`, so the honest answer on a half-migrated database is
  "not serving yet" rather than a 500 naming a missing relation.
