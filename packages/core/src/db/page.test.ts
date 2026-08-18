import { describe, expect, it } from "vitest";
import { createTestKobai } from "../testing/index.ts";
import { decodeCursor, encodeCursor } from "./page.ts";

/**
 * The one thing about a cursor that no request can see: that the instant inside it is spelled
 * the same way on every deployment.
 *
 * Everything else about paging is asserted through the HTTP seam, in
 * `http/pagination.test.ts`, and should stay there. This is here because the failure it guards
 * is a **property of the database session** rather than of a route: `DateStyle` and `TimeZone`
 * are settings a deployment owns, kobai pins neither, and every test database in this
 * repository is created seconds beforehand at the defaults — so a cursor rendered through them
 * is green everywhere here and refused by its own build at the first Postgres somebody
 * configured. That is the same shape as a migration meeting rows for the first time, and it
 * gets the same treatment: arrange the state this repository never otherwise reaches, then ask.
 */

/** A `DateStyle` no part of kobai chooses, and one that renders a date unrecognisably. */
const HOSTILE = "German, DMY";

/** What `cursorAt` promises to produce, and what `decodeCursor` refuses anything else for. */
const ISO_TO_THE_MICROSECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

describe("the instant inside a cursor", () => {
  it("is spelled the same way whatever DateStyle the database was left at", async () => {
    await using kobai = await createTestKobai();
    // Every `database.query` opens a connection of its own, so a setting made on the database
    // is what the next one starts from — which is exactly how a deployment's own configuration
    // would reach the application.
    await kobai.database.query(
      `alter database ${kobai.database.name} set datestyle to '${HOSTILE}'`,
    );

    const [rendered] = await kobai.database.query<{ cast: string; written: string }>(
      `select now()::text as cast,
              to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as written`,
    );

    // The hazard, shown rather than described: the cast this used to use produces something
    // `decodeCursor` refuses, so on this database every cursor kobai issued would be refused
    // at 400 on the next page — by kobai, for a value kobai wrote.
    expect(rendered?.cast).not.toMatch(ISO_TO_THE_MICROSECOND);
    expect(rendered?.written).toMatch(ISO_TO_THE_MICROSECOND);
    expect(
      decodeCursor(encodeCursor({ at: rendered?.written ?? "", id: SOME_ID })),
    ).toEqual({
      at: rendered?.written,
      id: SOME_ID,
    });
  });

  it("is read back by Postgres as the instant it named, under that same DateStyle", async () => {
    await using kobai = await createTestKobai();
    await kobai.database.query(
      `alter database ${kobai.database.name} set datestyle to '${HOSTILE}'`,
    );

    // The other half: a cursor is not only written, it is handed back as a `timestamptz` in the
    // comparison `rowsAfter` builds. ISO 8601 is the form no day-month-year reading can take
    // differently, and this is the assertion that says so rather than assuming it.
    const [round] = await kobai.database.query<{ same: boolean }>(
      `select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')::timestamptz = now()
              as same`,
    );

    expect(round?.same).toBe(true);
  });
});

/** Any identifier at all — this file is about the half of a cursor that is a timestamp. */
const SOME_ID = "00000000-0000-4000-8000-000000000000";
