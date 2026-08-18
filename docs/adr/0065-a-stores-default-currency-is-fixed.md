# A Store's default currency is fixed

`PATCH /admin/store` changes the Store's **name** and its **metadata**. It accepts a
`defaultCurrency` and refuses to move it — **422 `default-currency-is-fixed`** for any code
other than the one the Store already prices in — whatever the Store holds, and whether or not a
single Price has been written.

The rest of that route is
[ADR-0062](./0062-a-variant-is-corrected-in-place-and-a-price-is-superseded.md) applied to a
third record and needs no argument here: an absent field means "leave it", a named `metadata`
is replaced rather than merged, and a body that would change nothing is refused rather than
answered 200. The currency is the one field that is not like the others, and #172 was told not
to settle it by accident.

## Every Price already written is denominated in it, and says so nowhere useful

Since #5 a Price may carry only the Store's default currency: `setPrice` refuses any other with
`unsupported-currency`, and the reason it gives is that there is no rule yet for choosing
between two Prices in different currencies, so storing one would be inventing that rule by
accident.

So `core_price.currency` is not an independent fact — it is a copy of the Store's column, taken
at the moment the row was written. **Moving the Store's column does not move those copies, and
it does not have to in order to do damage.** What a Merchant means by "this Store prices in
EUR now" is that 1250 is EUR 12.50; what the database holds is a set of rows saying 1250 USD.
Whichever way that is resolved, an amount changes meaning:

- **Leave the rows and let them disagree with the Store** — a catalog quoting some Variants in
  a currency the Store does not price in, which is exactly the state `setPrice` refuses to
  create one row at a time and would now arrive wholesale.
- **Rewrite the rows to the new code** — 1250 cents becomes 1250 euro cents, an arbitrary
  revaluation of every Price in the catalog, applied silently by a request about the Store's
  name.
- **Convert the rows** — kobai has no rate, no source for one, no record of which rate was used
  and no way to be told. That is a feature with its own spec, not a line in an update.

None of the three is a decision anybody has taken, and taking it inside a `PATCH` that a
Merchant reached for to fix a typo in the Store's name is the worst place to take it.

## Refusing is the answer that keeps the decision takeable

**Decided: refuse, unconditionally, with a `reason` of its own.**

[ADR-0008](./0008-variants-are-sellable-and-prices-are-rows.md) already says where
multi-currency arrives when it does: a Price is a row precisely so that a second currency, a
Region, a Channel and a quantity break are **more rows** rather than a migration. So the shape
of the eventual answer is additive — a Price that names the currency it is in, resolved against
the Region a Shopper is buying from — and every one of those rows will need to know what the
rows already there meant. A column moved under them destroys exactly
that.

**The refusal is not narrowed to "when Prices exist", and that is deliberate.** A Store holding
no Price could be moved safely today, and it was tempting: it is the one case where nothing is
reinterpreted. Two counts against it. It makes the route's answer depend on a count taken a
moment before the write — a read followed by a write over a table any
`POST /admin/variants/{id}/prices` may be inserting into, which is the shape
[ADR-0018](./0018-one-reservation-model-implemented-without-holds.md) exists to refuse. And it
is the wrong direction to be wrong in: refusing always can be relaxed later, where a rule that
once allowed the change cannot be tightened without breaking a caller
([ADR-0060](./0060-the-http-surface-is-promised-and-a-refusals-reason-is-part-of-it.md)). A
deployment that wants another currency sets it before it has a catalog, in the configuration a
boot seeds the Store from.

**The field is on the request anyway.** Leaving `defaultCurrency` out of `UpdateStoreRequest`
would have been less code and a worse answer: the schema strips a field the route does not
carry, so `{ "defaultCurrency": "EUR" }` would have collapsed into the generic "you named
nothing" refusal, where a Merchant cannot tell a rule from an oversight and a client has no
word to branch on. Naming the code the Store already prices in is accepted and changes
nothing — so a form that submits the whole record round-trips, which is the same courtesy
`PATCH /admin/variants/{id}` extends to a SKU — and it is read case-insensitively, because
`usd` and `USD` are one code (`setPrice` upper-cases what it is given for the same reason).

**Considered and rejected: `unsupported-currency`, the word `setPrice` already answers with.**
It is a different sentence: there, a *Price* names a currency this Store does not price in, and
the repair is to send the Store's. Here the Store itself is the subject and there is no repair —
sharing the word would tell a client the two are one condition, and a client that branched on it
would offer the wrong advice for one of them.

**Considered and rejected: 409.** A 409 says somebody got there first and invites a retry; this
never becomes possible by itself, because what refuses it is every Price already written. 422 is
the status the surface already uses for a well-formed request refused by a fact about the Store.

## Consequences

- **`default-currency-is-fixed` is promised surface from the day it ships** (ADR-0060), and it
  is the only `reason` #172 added. It lives in `STORE_REASONS`, the Store's own refusal family,
  bound to `store/write.ts`'s union by the same mapped `satisfies` every other family uses — so
  renaming it turns `contract.ts` red.
- **The day a Price can name its own currency, this refusal is what has to be revisited** — not
  removed by reflex. Relaxing it needs an answer to what the rows already there mean, which is
  the question this record is holding open rather than closing.
- **`PATCH /admin/store` reads the Store and then writes it, and that is safe for one reason
  only**: no code path in kobai writes `default_currency` after the seed, this route being what
  guarantees it. The moment anything can, the check has to be carried by the write —
  `update … where default_currency = <what was read>` — and `store/write.ts` says so where the
  read is.
- **`store:write` is a new Permission**, seeded onto `owner` by
  `packages/core/migrations/0029`. Reading what a deployment is called and changing it are
  different powers — the split `catalog:read`/`catalog:write` and `api-key:read`/`api-key:write`
  already draw — and which gate a route sits behind is promised too, so it was not a decision to
  leave until there was traffic.
- **What a Store still cannot do is be renamed in the sense that matters commercially**: there
  is no currency migration, no Region, and no second Price to fall back on. That is a gap this
  record names rather than one it fixes.
