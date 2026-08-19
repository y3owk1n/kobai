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

/**
 * The module whose timers this file is entitled to count, as a stack frame names it.
 *
 * Attribution is by the frame that *called* `setTimeout`, never by the whole stack: `probe()`
 * hands its client back to the pool, and pg arms a ten-second idle timer of its own inside
 * that call — so `readiness.ts` sits in the stack of a timer it did not arm, and a whole-stack
 * match would count it.
 *
 * It is a path, so it couples this assertion to where that module lives. Moving `expiresIn`
 * elsewhere or renaming the file **reddens the build** rather than quietly emptying the count:
 * the guard in the test asks whether anything was attributed at all before believing that
 * nothing was left armed.
 */
const MODULE_UNDER_TEST = "/db/readiness.ts";

/** This file, whose own frames sit between `Error` and whoever armed the timer. */
const THIS_FILE = "/db/readiness.test.ts";

/** What `readiness.ts` did with timers over one window. */
type TimerAccount = {
  /**
   * How many it armed — every timer, the deadline and a retry's `sleep()` alike. Zero means
   * the attribution stopped matching anything rather than that the module armed nothing.
   */
  readonly armed: number;
  /** How many of those it had not stood down again when the window closed. */
  readonly leftArmed: number;
};

/**
 * The timers `readiness.ts` itself armed while `run` was in flight, and how many outlived it.
 *
 * Intervals as well as timeouts, because the count this replaced covered both — Node reports a
 * `setInterval` as a `"Timeout"` resource like any other, so dropping `setInterval` here would
 * have narrowed what the assertion sees while looking like it had only been made more precise.
 *
 * This used to be `process.getActiveResourcesInfo()`, counted once either side of the call
 * (#195). That is **process-wide**: it counts every armed `Timeout` anywhere in the Node
 * process, other test files sharing this vitest worker included, so anything at all arming or
 * disarming one inside that window moved the number. It was seen failing once as
 * `expected 2, received 1` during an unrelated gate run — a foreign timer *firing*
 * mid-assertion — and a test that fails for what another file was doing costs more than it
 * proves. Nothing here is a delta any more: a timer this call did not arm cannot be counted,
 * and a foreign one going away cannot uncount anything.
 *
 * Replacing a global to measure one is not the same trap it removes, and the difference is
 * worth being explicit about. What went wrong before was *reading* a number every other file
 * in the process could move; what happens here is a replacement that holds for the length of
 * one call, is put back in a `finally`, hands every timer it did not attribute straight to the
 * real function unwrapped, and counts nothing it did not attribute — so a foreign arm inside
 * the window is passed through and ignored rather than added, which is exactly what the old
 * count could not do.
 *
 * **Watched failing**, because an assertion nobody has seen fail is not yet known to be able
 * to: against a `waitForDatabase` whose `expiry.cancel()` was taken out, this reports
 * `leftArmed: 1` and the test fails on the line that says so — and again against a deadline
 * armed with `setInterval`, which is the half a narrower replacement would have stopped seeing.
 * The pg idle timer armed inside the same window is not what either caught: that one is
 * attributed to pg and never counted, and a count of everything armed in the window would have
 * reported it as a leak on the green build too.
 */
async function timersArmedBy(run: () => Promise<unknown>): Promise<TimerAccount> {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearTimeout = globalThis.clearTimeout;
  const realClearInterval = globalThis.clearInterval;
  const stillArmed = new Set<unknown>();
  let armed = 0;

  /**
   * `real`, with every timer the module under test arms through it counted and remembered.
   *
   * `forgetsItselfWhenItFires` is the whole of the difference between the two: a timeout that
   * has fired holds nothing open, so it leaves the set exactly as a cleared one does, while an
   * interval is still armed after its callback runs and stays until something clears it. Only
   * a timer this module armed is wrapped at all, so nobody else's callback is touched.
   */
  const watched =
    (real: Arm, forgetsItselfWhenItFires: boolean): Arm =>
    (callback, ms, ...args) => {
      if (!armedByModuleUnderTest()) return real(callback, ms, ...args);
      armed += 1;
      if (!forgetsItselfWhenItFires) {
        const handle = real(callback, ms, ...args);
        stillArmed.add(handle);
        return handle;
      }
      let handle: NodeJS.Timeout | undefined;
      handle = real(
        (...fired) => {
          stillArmed.delete(handle);
          callback(...fired);
        },
        ms,
        ...args,
      );
      stillArmed.add(handle);
      return handle;
    };

  const disarming =
    (real: Disarm): Disarm =>
    (handle) => {
      stillArmed.delete(handle);
      real(handle);
    };

  // `Object.assign` carries the real function's own properties across, rather than the one
  // `@types/node` names. Satisfying the type and preserving the behaviour are two different
  // jobs here: `__promisify__` is a declaration with nothing behind it — `"__promisify__" in
  // setTimeout` is `false` — and what `promisify()` actually reads is the enumerable
  // `Symbol(nodejs.util.promisify.custom)`, which assigning the narrow shape would have dropped.
  globalThis.setTimeout = Object.assign(watched(realSetTimeout, true), realSetTimeout);
  globalThis.setInterval = Object.assign(
    watched(realSetInterval, false),
    realSetInterval,
  );
  globalThis.clearTimeout = disarming(realClearTimeout);
  globalThis.clearInterval = disarming(realClearInterval);

  try {
    await run();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.clearInterval = realClearInterval;
  }

  return { armed, leftArmed: stillArmed.size };
}

/** `setTimeout` and `setInterval`, which take and give back the same things. */
type Arm = <TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  ms?: number,
  ...args: TArgs
) => NodeJS.Timeout;

/** `clearTimeout` and `clearInterval`, likewise. */
type Disarm = (handle?: NodeJS.Timeout | string | number) => void;

/**
 * Whether whoever armed the timer now being created is the module under test.
 *
 * The arming call is the first frame that is not this file's, rather than a frame at a fixed
 * depth: the stack opens with `Error`'s own line and then however many frames this file
 * contributes between raising it and the replacement above — which was two, until it was
 * three, and counting them is the kind of thing that reads as an empty count rather than as a
 * failure. The emptiness guard in the test caught exactly that.
 */
function armedByModuleUnderTest(): boolean {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  const armer = frames.find((frame) => !frame.includes(THIS_FILE));
  return armer?.includes(MODULE_UNDER_TEST) === true;
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

    const timers = await timersArmedBy(() =>
      booting.waitForDatabase({ timeoutMs: 30_000 }),
    );

    // Asked before it is believed: an attribution that matched nothing would leave the
    // assertion below passing against a `waitForDatabase` that armed a deadline and abandoned
    // it, which is ADR-0049's trap arriving as a green build. Against a database that is
    // already up nothing retries, so the timer it counts here is the deadline and no other.
    expect(
      timers.armed,
      "No timer was attributed to the module under test, so the count below is empty rather than clean.",
    ).toBeGreaterThan(0);
    // The deadline lost the race and was stood down. Left armed, a `setTimeout` for thirty
    // seconds holds the event loop open — invisible to a server that has just bound a port,
    // and thirty seconds of nothing to any script that called this and expected to exit.
    expect(timers.leftArmed).toBe(0);
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
