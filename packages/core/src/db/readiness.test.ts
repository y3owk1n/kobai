import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKobai, type Kobai } from "../kobai.ts";
import { createTestDatabase, type TestDatabase } from "../testing/database.ts";
import { silentLogger } from "../testing/kobai.ts";

/**
 * `waitForDatabase()` — the half of a boot that is not a migration (#80, ADR-0048).
 *
 * A database that has not finished starting and a migration that failed are different
 * facts, and Core used to be unable to tell them apart: `migrate()` reaches for the
 * database on its first statement, so a connection refused came back as
 * `{ ok: false, set: "core", message: 'Failed query: CREATE SCHEMA …' }` — Core's migration
 * set named as the thing that failed, when nothing had been run at all. The reference
 * Project then refused to start, correctly (#2, ADR-0031), and said the wrong reason.
 *
 * So they are two calls now, and what makes them distinguishable is that structure rather
 * than a string: waiting is bounded and retried, migrating is neither. These tests hold both
 * halves of that — that a wait is a wait, and that it leaves the migration lifecycle alone.
 */

/**
 * A throwaway database, like every other test here — even though nothing below writes to
 * one. What is under test is a connection, and a connection is to *a* database: pointing
 * these at the maintenance database instead would leave the suite's own address as an
 * implicit argument to every case.
 */
let database: TestDatabase;
let kobai: Kobai | undefined;
let proxy: net.Server | undefined;

beforeEach(async () => {
  database = await createTestDatabase();
});

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
  await new Promise<void>((resolve) => {
    if (proxy === undefined) return resolve();
    proxy.close(() => resolve());
  });
  proxy = undefined;
  await database.drop();
});

function bootAgainst(databaseUrl: string): Kobai {
  kobai = createKobai({ databaseUrl, logger: silentLogger });
  return kobai;
}

/** What is still holding the event loop open, as Node itself reports it. */
function timersArmed(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
}

/** A port nothing is listening on — `127.0.0.1:1` is refused rather than dropped. */
const NOTHING_LISTENING = "postgres://kobai:kobai@127.0.0.1:1/kobai";

/** A port free at the moment it was asked for, so a proxy can claim it a moment later. */
async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * A Postgres that starts answering late, without a container to start late.
 *
 * A plain TCP forwarder to the real database, which begins listening after `afterMs`. Until
 * then the port refuses connections — exactly what `app` meets when it dials `db` before
 * Postgres is up, and the only part of that situation a test can reproduce in milliseconds.
 */
async function postgresArrivingLate(afterMs: number): Promise<string> {
  const upstream = new URL(database.url);
  const port = await reservePort();

  proxy = net.createServer((client) => {
    const server = net.connect(Number(upstream.port), upstream.hostname);
    client.pipe(server).pipe(client);
    // A forwarder is not the subject; a broken pipe on either side just ends the pair.
    for (const socket of [client, server]) socket.on("error", () => socket.destroy());
  });

  const listening = proxy;
  setTimeout(() => listening.listen(port, "127.0.0.1"), afterMs);

  const url = new URL(database.url);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return url.toString();
}

describe("waiting for the database", () => {
  it("returns at once when the database is already accepting connections", async () => {
    const ready = await bootAgainst(database.url).waitForDatabase();

    expect(ready.ok).toBe(true);
    // The common case, and the one that must cost nothing: a boot against a database that
    // is already up asks once and moves on.
    expect(ready.attempts).toBe(1);
  });

  it("leaves no timer armed behind it, so a caller that is finished can exit", async () => {
    const booting = bootAgainst(database.url);
    // Warmed first: the pool arms an idle timer of its own the first time a client goes
    // back into it, and this is about the deadline's timer rather than that one.
    await booting.waitForDatabase();
    const before = timersArmed();

    await booting.waitForDatabase({ timeoutMs: 30_000 });

    // The deadline lost the race and was stood down. Left armed, a `setTimeout` for thirty
    // seconds holds the event loop open — invisible to a server that has just bound a port,
    // and thirty seconds of nothing to any script that called this and expected to exit.
    expect(timersArmed()).toBe(before);
  });

  it("keeps trying while the database is not there yet, and proceeds when it arrives", async () => {
    const url = await postgresArrivingLate(500);

    const ready = await bootAgainst(url).waitForDatabase({
      timeoutMs: 20_000,
      intervalMs: 50,
    });

    expect(
      ready.ok,
      "A database that was a moment late was treated as a database that never came.",
    ).toBe(true);
    // More than one attempt is the proof that it waited rather than got lucky.
    expect(ready.attempts).toBeGreaterThan(1);
  });

  it("gives up at the deadline rather than blocking a boot forever", async () => {
    const started = Date.now();

    const ready = await bootAgainst(NOTHING_LISTENING).waitForDatabase({
      timeoutMs: 400,
      intervalMs: 50,
    });

    expect(ready.ok).toBe(false);
    // Bounded, because #2's refusal is the point: an instance that hung here would be
    // neither serving nor telling anyone why, which is worse than exiting.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports an absent database as its own fact, not as a failed migration", async () => {
    const booting = bootAgainst(NOTHING_LISTENING);

    const ready = await booting.waitForDatabase({ timeoutMs: 200, intervalMs: 50 });

    expect(ready.ok).toBe(false);
    // The distinction the whole design rests on. Nothing was migrated, so nothing claims to
    // have failed to migrate — `/health` still says this instance is booting, and the moment
    // it says `error` a migration really did fail.
    expect(booting.migrationState()).toEqual({ status: "pending" });
    expect(ready.ok === false && ready.message).toContain("127.0.0.1:1");
  });

  it("does not wait out the deadline on a refusal that waiting cannot fix", async () => {
    // A password Postgres rejects is a broken deployment, not a slow one. Retrying it would
    // buy nothing and would delay the only useful thing — saying so — by the whole deadline.
    const url = new URL(database.url);
    url.password = "not the password this database was given";
    const started = Date.now();

    const ready = await bootAgainst(url.toString()).waitForDatabase({
      timeoutMs: 30_000,
      intervalMs: 50,
    });

    expect(ready.ok).toBe(false);
    expect(ready.attempts).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
