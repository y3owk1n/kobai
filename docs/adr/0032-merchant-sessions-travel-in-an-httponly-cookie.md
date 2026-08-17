# Merchant sessions travel in an httpOnly cookie, and SameSite is the CSRF answer

A Merchant session is presented as an httpOnly `kobai_session` cookie, set by
`POST /admin/session` and cleared by `DELETE /admin/session`. It replaces
`Authorization: Bearer <session token>`, which was chosen as a default rather than a
decision. **The store surface is untouched**: an API key still travels as
`Authorization: Bearer kobai_pk_… | kobai_sk_…`.

The cookie is `HttpOnly`, `SameSite=Strict`, `Secure` whenever the request arrived over HTTPS,
and carries **no** `Path`, `Expires` or `Max-Age`. `SameSite=Strict` is the whole of the CSRF
defence, and this record exists mostly to say why that is enough and what it does not cover.

## Why the transport moved

**The token was a published field of a response body.** `IssuedSession` carried `token`, so
it was in `packages/core/openapi.json` and in `@kobai/client`'s generated types. That makes a
live credential something a response logger writes to disk *by doing its job* — a quiet
exposure that grows with every logging integration anyone ever adds, and one that no amount
of care at the call site prevents, because the leak is not at a call site. An httpOnly cookie
is written once, by the browser, and read once, by the gate. No body carries it and no script
can reach it.

**The client gets simpler, not harder.** `KobaiCredential` was a union only because two
surfaces authenticated differently. Under a cookie it is just the API key: the browser sends
the session by itself on the same origin, and the typed client stops modelling it at all.

**The any-language argument never applied here.** It is what justified Bearer originally, and
it still justifies it for the store surface, which is server-to-server and whose caller
composes its own requests in whatever language it likes. The Admin is not that caller.
ADR-0010 puts it in the same container as the API, which makes it same-origin, which is
exactly the case a cookie is for.

## Why `SameSite=Strict`, and why nothing else

`Strict` costs the Admin nothing. A cross-site link into it loads the SPA's HTML, which needs
no credential; every call the SPA then makes is same-site, because the top-level document is
kobai's own, and carries the cookie normally. Nothing enters the admin surface from another
site — no SSO callback, no payment return, no magic link — so `Lax`'s allowance for top-level
GET navigations would be a hole held open for a flow that does not exist. `Strict` is not the
cautious choice here; it is the one with no downside to weigh.

With `Strict` the cookie is never attached to a cross-site request at all, and a request
without the credential is not a forged one. So there is **no CSRF token and no `Origin`
check**, and both were considered:

- **A double-submit token** needs a second cookie that JavaScript *can* read and a header the
  Admin attaches to every call — machinery whose only job is to re-prove what the browser has
  already refused to do.
- **An `Origin` check on unsafe methods** (Hono ships `csrf()` for it) refuses any request
  carrying no `Origin`, which is every non-browser client; the admin surface is still a REST
  API a script may drive with a cookie jar.

### What this does not cover, stated plainly

`SameSite` is scoped to the **site** — the registrable domain — and not to the origin. A
sibling host on the same registrable domain is same-site, so a storefront at
`shop.example.com` can forge a request to an Admin at `admin.example.com` and the browser
will attach the cookie. That is a real residual risk and it is accepted here rather than
mitigated, because the deployment ADR-0010 describes is one origin serving both the Admin and
the API, and because a storefront is Project-owned code the Merchant already trusts with a
secret API key.

**Two things should reopen this decision rather than be worked around:** a flow that must
enter `/admin` from another site, and a deployment that puts content kobai does not trust on
the same registrable domain as the Admin. Either makes an `Origin` check the next step, and
the second makes it urgent.

## Why the other attributes

**`HttpOnly`** is the property the change was made for.

**No `Path`, so the browser scopes it to the admin surface it was issued from.** The intent is
unchanged from the first version of this record: keep the credential out of requests that have
no use for it — `/store`, `/health`, and whatever else a Project serves from the same origin.
Path is not a boundary between origins and is not claimed as one; it is the same argument the
cookie itself makes, that a value which never reaches a handler is a value that handler cannot
log. What changed is how the scope is arrived at, and #65 is why.

A `Set-Cookie` naming no `Path` is filed by the browser under RFC 6265's **default-path**: the
directory of the URI it arrived from. Sign-in is `POST …/admin/session`, so the cookie is
scoped to `…/admin` — `/admin` at the root, `/api/admin` for a Project that mounted kobai at
`/api` — and RFC 6265's path-match then sends it to that subtree and nowhere else. The scope
follows the mount without anyone declaring the mount.

**The literal `Path=/admin` could not do that, and no attribute Core computes can.** ADR-0031
hands a Project Core's `fetch` to bind, and a Project is equally free to mount it under a
prefix — this record is where that becomes a promise. Both ways of mounting a `fetch` handler
under a prefix — a Hono `mount`, a reverse proxy that rewrites the prefix away — strip the
prefix *before* Core sees the request. Core is handed `/admin/session` either way; the request
and the routed path are identical, so there is no difference to read a prefix out of. The
browser is the only party that knows the URI it asked for, so the browser is what computes the
scope. The alternative was a `basePath` in `kobai.config.ts`, which would make a Project
declare its mount twice and be a defect the moment the two disagreed — the failure it was
meant to prevent, moved into config.

Two consequences are worth stating.

- **Sign-in and sign-out agree by construction.** A browser matches a deletion to a stored
  cookie by name, domain and path, so a clear that disagreed about `Path` would leave the old
  cookie in place and sign-out would only look like it had worked. With neither naming a
  `Path`, both are scoped from the URI they arrived at — and that is the *same* URI, since
  sign-in and sign-out are one route under two methods. There is no second constant to keep in
  step.
- **The depth of `POST /admin/session` is now load-bearing.** The cookie covers the admin
  surface because sign-in sits one segment below it. Moving sign-in deeper, to
  `/admin/auth/session`, would silently narrow the cookie to `/admin/auth` and refuse every
  other admin request. `packages/core/src/auth/session-cookie.test.ts` drives a cookie jar
  against a mounted Core precisely so that stays a failing test rather than a production
  discovery.

It still claims nothing about the Admin's *own* assets: ADR-0010 serves those at a path Core
does not choose, and if that path sits under the admin surface they carry the cookie like
everything else there.

**`Secure` follows the scheme the request arrived over**, honouring `X-Forwarded-Proto` and
falling back to the request URL. A fixed `Secure` would make `devbox run up` — plain HTTP on
localhost — unable to sign in at all, and a fixed absence of it would ship a credential over
plaintext in production. Reading it from the request means one build is correct in both, with
nothing to configure and no environment variable to get wrong. The header is trusted because
TLS is almost always terminated in front of a one-container deployment, so a process judging
by its own socket alone would drop `Secure` from every cookie a real deployment set; and
lying in it costs the liar their own cookie and nobody else theirs, since a browser cannot be
made to add the header to a cross-origin request.

**No `Expires` and no `Max-Age`**, which is the attribute most likely to be added by mistake.
A cookie that expired in the browser would simply stop being sent, and the request after it
would be indistinguishable from an anonymous one — so a Merchant whose session ran out would
get the empty page an anonymous request gets, where the Admin owes them a sign-in prompt.
`session-expired` is a distinct answer on purpose. Leaving the lifetime entirely to the
`core_session` row keeps the database the single authority on it.

**No `__Host-` or `__Secure-` prefix.** Both make `Secure` mandatory, which would break local
HTTP; `__Host-` additionally forces `Path=/`, which would send the session to everything the
Project serves — the opposite of the scoping above, and not something the browser could then
narrow.

## Consequences

- **`IssuedSession` is gone from the API.** With the token in a cookie it was identical to
  `Session`, so `POST /admin/session` answers `Session`. `@kobai/client` no longer exports the
  name.
- **`KobaiCredential` is no longer a union** — it is `{ apiKey }`. A caller driving `/admin`
  from outside a browser keeps the cookie itself, the way a browser does.
- **The admin surface sends no `WWW-Authenticate`.** RFC 6750's challenge names the scheme a
  request failed to satisfy, and there is no registered scheme for a cookie; naming `Bearer`
  would be an instruction no client could act on. The store surface still sends it. A client
  branches on `SessionRefusal.reason`, which is unchanged.
- **`session-missing | session-malformed | session-unknown | session-expired` keep their
  meanings.** No cookie is `missing`; a `kobai_session` carrying nothing is `malformed`.
- **A session presented at `/store` now reads as `api-key-missing`** rather than
  `api-key-malformed`. It arrives in a header that gate does not read — and a browser would
  not send it there at all, since `/store` is outside the cookie's scope.
- **The Admin (#10) has no credential to store, and must not try.** It signs in, and every
  later request carries the cookie because it is same-origin. `fetch` defaults to sending
  same-origin cookies, so there is nothing to configure — which is the same thing ADR-0010
  bought by removing CORS from the setup path.
