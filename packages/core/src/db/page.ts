import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * How a list route hands back one page of a table, and how the next one is found (ADR-0064).
 *
 * **A cursor rather than an offset, and the argument is not about speed.** `limit`/`offset` is
 * evaluated against the table as it is at the moment each page is fetched, so a row inserted
 * between page 1 and page 2 shifts everything down by one — and under the `desc` sort every
 * list here wants, that row pushes one off the bottom of page 1, where it is then never shown
 * at all. Orders take concurrent inserts from every `POST /store/orders`, so a Merchant paging
 * through them during a busy hour is the ordinary case. A keyset is evaluated against the
 * *record* the caller last saw — `where (created_at, id) < (that row's)` — so what has been
 * inserted since changes nothing about what follows it.
 *
 * **The ordering must not be able to tie**, which is why every cursor here is a pair and every
 * query ends its `order by` in `id`. #132 already paid for that lesson where a tie made the
 * upgrade gate's byte comparison red *sometimes*; at a page boundary the same tie skips or
 * repeats a row instead of merely reordering it.
 *
 * **The cursor is opaque, and that is a promise about what it is not.** ADR-0064 keeps the sort
 * key and the tiebreaker an implementation detail, so nothing outside this module reads what is
 * inside one — the routes carry it as a string, and this is the only place that knows it is a
 * timestamp and an id at all.
 *
 * **A cursor says which list issued it, and no other list will read it** (#183). One cut from
 * `GET /admin/products` used to decode on `GET /admin/orders`, satisfy the schema, and answer a
 * plausible page of the wrong list — a client's mistake arriving as a 200 rather than as a
 * refusal, which is the class of quiet wrongness ADR-0064 was written against one level up.
 * {@link PagedList} is the name a list is known by inside its own cursors.
 *
 * **A cursor is not signed, and that was decided rather than deferred** (#183) — see
 * {@link encodeCursor} for the argument and ADR-0064 for the record of it.
 */

/**
 * The name a list is known by inside the cursors it issues, and the whole of what binds the one
 * to the other.
 *
 * **Spelled once per list, at that route's `contract.pageQuery(…)`.** The same call decides what
 * {@link decodeCursor} will accept and what {@link takePage} will write — the name reaches a
 * reader on its {@link PageRequest} rather than as an argument of its own — so the two ends of a
 * cursor cannot be bound to different lists by anybody forgetting to keep them in step.
 *
 * A closed union rather than a `string`, so the set is readable in one line — which matters
 * because a **collision** is the only way this scheme still fails, and no type can see one: a
 * union quietly absorbs a repeated member, and two lists sharing a name would trade cursors
 * exactly as an unbound cursor did. What sees it is `http/pagination.test.ts`, in two cases
 * that only work together — one offers every list's cursor to every other list and expects all
 * of them to refuse, and the other holds that test's table of lists against the routes the
 * OpenAPI description says take an `after`, so a list added without an entry reddens the build
 * instead of quietly opting out of the sweep.
 *
 * **A name carries no space**, because {@link encodeCursor} joins the parts with one. That holds
 * by inspection of this line, which is the other reason the line is worth being able to read.
 *
 * **A list is a route, not a table**, which is what `store-products` is here to say. It and
 * `products` page the same rows in the same order — `GET /store/products` and
 * `GET /admin/products` — and they are still two lists, because they answer two *shapes* behind
 * two credentials and a cursor names the list that issued it. Naming them both `products` would
 * make each accept the other's cursor, which is the collision this union exists to keep
 * readable; and it would promise a storefront that a Merchant's cursor is portable onto the
 * store surface, which is a promise nothing else here makes. When one of them grows a filter the
 * other has not got, the pair stops being an accident of two names for one query and becomes two
 * genuinely different traversals — so the split is where it will be wanted rather than where it
 * merely costs nothing today.
 */
export type PagedList =
  | "products"
  | "orders"
  | "api-keys"
  | "roles"
  | "merchants"
  | "store-products"
  | "carts";

/** What a caller asked for: how many, and what they have already seen. */
export type PageRequest = {
  /** How many rows to answer with. Already checked against the ceiling by the route's schema. */
  readonly limit: number;
  /** Where to resume from — the last row of the previous page, or nothing for the first. */
  readonly after?: Cursor;
  /**
   * Which list this is a page of — what a cursor issued here will name, and what one handed
   * back has to have named already.
   *
   * It comes from the route's own `contract.pageQuery(…)` rather than from the caller, so a
   * reader cannot page one list under another's name and no reader has to remember to say
   * which list it is.
   */
  readonly list: PagedList;
};

/**
 * One page of a list, and how to ask for the next.
 *
 * `nextCursor` is `undefined` when there is no further row — and so **absent** on the wire,
 * which `JSON.stringify` does for a key whose value is `undefined`. Its absence is the only
 * end-of-list signal a caller gets. A short page is not one: this fetches one row more than it
 * was asked for and reports a cursor when that row exists, so a page that came back short
 * because rows were filtered out still says there is more.
 */
export type Page<Item> = {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
};

/**
 * A position in a `(created_at desc, id desc)` ordering — the record a page resumed from.
 *
 * `at` carries **microseconds and never a JavaScript `Date`**. A `Date` holds milliseconds and
 * `now()` holds microseconds, so a cursor that had been through one would compare unequal to
 * the row it came from: rows sharing its millisecond but carrying microseconds of their own
 * would fall on the wrong side of the comparison and never be shown. That is the silent skip
 * this whole scheme exists to refuse, arriving through the back door.
 *
 * **It is a spelling this module chooses rather than one Postgres chooses for it**, which is
 * the other half of that (see {@link cursorAt}). `at` is ISO 8601 in UTC to the microsecond —
 * `2026-08-18T09:41:07.123456Z` — and {@link decodeCursor} holds it to exactly that, because
 * a cursor a build cannot read back is worse than no cursor at all.
 */
export type Cursor = {
  readonly at: string;
  readonly id: string;
};

/** How many rows a caller who asked for no particular number gets. Promised (ADR-0064). */
export const DEFAULT_PAGE_LIMIT = 20;

/**
 * The most any one request may ask for.
 *
 * A request over it is **refused rather than clamped**: a caller that asked for 5,000 and
 * received 100 would read the short page as the end of the list, which is the same silent
 * wrongness as an offset.
 */
export const MAX_PAGE_LIMIT = 100;

/**
 * The cursor as it travels — base64url, so it carries through a query string untouched.
 *
 * **The list is inside it, and first.** A space joins the three parts and no {@link PagedList}
 * holds one, which is what lets {@link decodeCursor} split them back apart without a format to
 * parse.
 *
 * **Not a signature and not encryption**, and #183 is where that stopped being an omission and
 * became a decision. base64url reverses in one command, so *opaque* here means nothing is
 * promised about what is inside — not that nobody can look. Signing was weighed and declined,
 * on three grounds, and ADR-0064 carries the record:
 *
 * - **It would defend nothing.** A forged cursor names a *position*, and every position it can
 *   name is inside a list the caller's credential already opens whole — these routes are behind
 *   a Merchant session and a `…:read` Permission, and the answer to `after=<anything>` is a page
 *   of the list they were already reading. There is no row a cursor reaches that a `limit` does
 *   not.
 * - **It would need kobai's first secret.** `kobai.config.ts` holds no key of any kind, so this
 *   would introduce one — with rotation, with every instance behind a load balancer having to
 *   agree, and with a Merchant's open page breaking the moment the key moved. That is a config
 *   surface and an ADR, for the benefit above.
 * - **Obfuscating without a key would be worse than either.** It reads as protection, is none,
 *   and would still have to be undone the day a real one is wanted.
 *
 * What is genuinely at risk is **coupling**: a client that unpicks a cursor starts depending on
 * the sort key and the tiebreaker, which is exactly what ADR-0064 keeps private. That is
 * answered by saying so rather than by hiding it — the `after` parameter's own description
 * promises nothing about the contents and says to send it back as received — and a client that
 * reads past it is relying on internals kobai may change without a major.
 *
 * **Reopening this is a wire-format change**, and therefore a major once anything is published
 * (ADR-0060, ADR-0061). The thing that would reopen it is a cursor carrying something a caller
 * must not be allowed to choose — a filter, a scope, a Store — because that is the first
 * version of this where forging one reaches a row rather than a position.
 */
export function encodeCursor(list: PagedList, cursor: Cursor): string {
  return Buffer.from(`${list} ${cursor.at} ${cursor.id}`, "utf8").toString("base64url");
}

/**
 * A cursor read back, or `undefined` for anything that is not one **this list** wrote.
 *
 * The route's schema is what asks — an `after` that does not decode does not fit the endpoint,
 * so it is refused at 400 like any other unusable parameter rather than quietly treated as the
 * first page. Starting over would be the worst of the answers available: the caller would page
 * the same rows again and never learn why.
 *
 * **A cursor from another list is refused as the same `invalid`, and that is a decision** (#183,
 * ADR-0060). A new `reason` would be permanent and would turn every exhaustive `switch` over a
 * regenerated `@kobai/client` into an incomplete one — bought for a distinction no client can
 * act on differently, since both answers mean *stop sending this value*. `invalid` is already
 * the word for a query parameter that does not fit this endpoint, and a cursor another list
 * issued is precisely that. The diagnosis a person needs is in the `error` string, which names
 * the list that would have had to issue it and is promised to nobody.
 */
export function decodeCursor(list: PagedList, raw: string): Cursor | undefined {
  const [issuer, at, id, ...extra] = Buffer.from(raw, "base64url")
    .toString("utf8")
    .split(" ");
  if (issuer === undefined || at === undefined || id === undefined || extra.length > 0)
    return undefined;

  // Checked before the pair below, because a cursor from another list is *well formed*: it
  // decodes, it names a real row, and every check after this one passes. This is the only one
  // that can tell it apart from the cursor this list handed out.
  if (issuer !== list) return undefined;

  // A timestamp and a uuid are what the pair is made of, and both are checked before either
  // reaches a cast in SQL: `at` is handed to Postgres as a `timestamptz` and a string that is
  // not one would raise there, which is a 500 for what is a caller's mistake.
  if (!CURSOR_TIMESTAMP.test(at)) return undefined;
  if (!CURSOR_UUID.test(id)) return undefined;

  return { at, id };
}

/**
 * The one spelling of an instant a cursor may carry, and it is exactly what {@link cursorAt}
 * writes: ISO 8601, UTC, six digits of fraction.
 *
 * Exact rather than permissive, because the two ends have to agree and this is the end that
 * can say so. Postgres accepts a wide range of timestamp input, so a looser pattern here would
 * be a cursor kobai never issued being accepted and paging from somewhere nobody named.
 */
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The timestamp a cursor is built from, selected **as text** beside the row's own columns.
 *
 * The column is already selected as a `Date` wherever a response reports it, and this is
 * deliberately a second reading of the same column rather than a re-use of that one: the
 * response wants an ISO string a person reads and the cursor wants the microseconds Postgres
 * is actually ordering by, and a `Date` cannot carry both. See {@link Cursor}.
 *
 * **`to_char` with an explicit pattern rather than `::text`, and that is not a style
 * preference.** Casting a `timestamptz` to text renders it through the session's `DateStyle`
 * and `TimeZone`, which are settings a deployment owns and kobai pins nowhere — so on a
 * database left at `DateStyle = 'German, DMY'` a cast would produce `18.08.2026 …`, every
 * cursor kobai issued would fail {@link decodeCursor}'s own check, and every second page would
 * be refused at 400 for a cursor kobai itself wrote. This spells the instant itself: `at time
 * zone 'UTC'` settles the offset, the pattern is digits and punctuation only so no locale
 * touches it, and `US` is the six fractional digits the whole scheme rests on.
 *
 * Reading it back is safe for the same reason from the other side: the ISO 8601 form the
 * pattern produces is the one Postgres parses identically under every `DateStyle`, because
 * there is nothing in `2026-08-18T09:41:07.123456Z` that a day-month-year reading could take
 * differently.
 */
export function cursorAt(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Everything that follows the row this request resumed from, in a `(created_at desc, id desc)`
 * ordering — or nothing to constrain at all, on a first page.
 *
 * It takes the request rather than the cursor so that the first page is this function's case
 * rather than a ternary each reader writes for itself, which is a ternary each reader could
 * write backwards.
 *
 * A **row comparison** rather than `created_at < :at or (created_at = :at and id < :id)`, which
 * is the same predicate written where it can be got wrong. Postgres evaluates this one against
 * the index the ordering already uses.
 */
export function rowsAfter(
  request: PageRequest,
  at: PgColumn,
  id: PgColumn,
): SQL | undefined {
  const cursor = request.after;
  if (cursor === undefined) return undefined;

  return sql`(${at}, ${id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
}

/** How many rows to fetch to answer a page of `limit` — one more, which is how `nextCursor` is known. */
export function pageSize(request: PageRequest): number {
  return request.limit + 1;
}

/**
 * The rows of the page, and the cursor for what follows — from the `limit + 1` rows fetched.
 *
 * The extra row is looked at and thrown away. It is the whole of what tells "this is the last
 * page" from "this page happens to be full", and asking the database for a count instead would
 * be a second query over the whole table to answer a question with two possible answers.
 *
 * **The row shape is the contract, and `cursorAt` is the name to select under.** A reader
 * writes `cursorAt: cursorAt(table.createdAt)` in its `select` and this reads it back; a reader
 * that named it something else fails to compile here rather than paging wrongly. The column is
 * for this function alone and belongs in no response, which is why every reader builds its
 * items field by field rather than spreading a row.
 */
export function takePage<Row extends { readonly id: string; readonly cursorAt: string }>(
  fetched: readonly Row[],
  request: PageRequest,
): { readonly rows: readonly Row[]; readonly nextCursor?: string } {
  if (fetched.length <= request.limit) return { rows: fetched };

  const rows = fetched.slice(0, request.limit);
  const last = rows.at(-1);
  // Unreachable — `fetched` is longer than `limit`, and `limit` is at least one — and typed
  // rather than asserted away, because an empty page with a cursor on it would be a list that
  // never ends.
  if (last === undefined) return { rows };

  return {
    rows,
    nextCursor: encodeCursor(request.list, { at: last.cursorAt, id: last.id }),
  };
}
