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
 */

/** What a caller asked for: how many, and what they have already seen. */
export type PageRequest = {
  /** How many rows to answer with. Already checked against the ceiling by the route's schema. */
  readonly limit: number;
  /** Where to resume from — the last row of the previous page, or nothing for the first. */
  readonly after?: Cursor;
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
 * Not encryption and not a signature. It is opaque in the sense that matters: nothing is
 * promised about what is inside it, so kobai may change how a page is located without changing
 * anybody's client. Nothing is protected by it either — a caller who unpicks one and hands back
 * a position of their own choosing gets a page of the same list they were already reading, and
 * every list this opens is one their credential already opens whole.
 *
 * **A cursor does not say which list it came from**, so one cut from Products is structurally
 * valid on Orders and answers a plausible page of the wrong list rather than a refusal. Binding
 * it would mean a schema per list where ADR-0064 asks for one, and the mistake it would catch
 * is a caller passing a client's own value to the wrong call. Left undone deliberately; the day
 * a list wants a cursor of a different shape, that is where this is reopened.
 */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at} ${cursor.id}`, "utf8").toString("base64url");
}

/**
 * A cursor read back, or `undefined` for anything that is not one this build wrote.
 *
 * The route's schema is what asks — an `after` that does not decode does not fit the endpoint,
 * so it is refused at 400 like any other unusable parameter rather than quietly treated as the
 * first page. Starting over would be the worst of the answers available: the caller would page
 * the same rows again and never learn why.
 */
export function decodeCursor(raw: string): Cursor | undefined {
  const [at, id, ...extra] = Buffer.from(raw, "base64url").toString("utf8").split(" ");
  if (at === undefined || id === undefined || extra.length > 0) return undefined;

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

  return { rows, nextCursor: encodeCursor({ at: last.cursorAt, id: last.id }) };
}
