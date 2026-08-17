import type pg from "pg";

/**
 * Whether the database is there yet — asked and answered separately from whether its
 * migrations applied (ADR-0048).
 *
 * These are two different facts about a boot and they used to arrive as one. `migrate()`
 * reaches for the database on its first statement, so a Postgres that had not finished
 * starting came back as a *failed migration set*: `set: "core"`, `Failed query: CREATE
 * SCHEMA IF NOT EXISTS "drizzle"`. The refusal that followed was right — serving against a
 * half-migrated schema is worse than not serving (#2, ADR-0031) — and the reason it gave was
 * wrong, which is the harder half to notice and the expensive half to debug.
 *
 * So this is its own call, with its own result, and the two are told apart by structure
 * rather than by reading a string: waiting is bounded and retried, migrating is neither.
 * Nothing here ever retries a migration.
 */
export type DatabaseReadiness =
  | {
      readonly ok: true;
      /** How many connections it took. `1` is a database that was already up. */
      readonly attempts: number;
      readonly waitedMs: number;
    }
  | {
      readonly ok: false;
      readonly attempts: number;
      readonly waitedMs: number;
      /** What the database said, or what the socket did. Never a migration's message. */
      readonly message: string;
      readonly cause: unknown;
    };

export type WaitForDatabaseOptions = {
  /**
   * How long to keep trying. The default is a backstop rather than the mechanism: a
   * Developer's `docker compose up` is ordered by the `db` healthcheck, and this is for
   * every deployment that has no such ordering to offer.
   */
  readonly timeoutMs?: number;
  /** How long to leave between attempts. */
  readonly intervalMs?: number;
};

/** Long enough for a Postgres a moment behind; short enough that a boot still fails loudly. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 250;

/**
 * Told to Core's logger the first time the database is not there, and never again — a line
 * per attempt would bury the one that matters under a hundred identical ones.
 */
type Watcher = {
  onWaiting?(detail: { readonly attempt: number; readonly message: string }): void;
};

/**
 * The errors waiting can fix, and so the only ones retried.
 *
 * Everything else fails at once, on purpose. A password Postgres rejects is a broken
 * deployment rather than a slow one; retrying it would buy nothing and would delay the only
 * useful response — saying so — by the whole deadline. That distinction is the same one this
 * module exists to draw, one level down.
 */
const WAITING_MIGHT_FIX = new Set([
  // Nothing is listening on the socket yet, or the connection died as the server restarted.
  // The official Postgres image restarts once, partway through initialising a fresh volume.
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  // The name has no address yet — a compose service, or a DNS record, that is a moment
  // behind the container asking for it.
  "ENOTFOUND",
  "EAI_AGAIN",
  // Postgres itself, saying it cannot take the connection yet. `cannot_connect_now` is what
  // both "the database system is starting up" and "…is shutting down" arrive as.
  "57P03",
  // The connection failed rather than being refused: a startup packet lost to a restart.
  "08006",
  "08001",
  "08003",
]);

/**
 * Waits for the database to accept a connection, up to a deadline.
 *
 * Through the pool the application itself will use, so what this proves is what the
 * application needs: this address, these credentials, this database, reachable now. A probe
 * that dialled anything else could be satisfied by a Postgres the application cannot use.
 */
export async function waitForDatabase(
  pool: pg.Pool,
  options: WaitForDatabaseOptions & Watcher = {},
): Promise<DatabaseReadiness> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const started = Date.now();
  const deadline = started + timeoutMs;

  let attempts = 0;
  let lastError: unknown;

  /** Both ways this can fail, so the shape of a refusal is written once. */
  const refused = (message: string): DatabaseReadiness => ({
    ok: false,
    attempts,
    waitedMs: Date.now() - started,
    message,
    cause: lastError,
  });
  const gaveUp = () =>
    refused(
      `the database did not accept a connection within ${timeoutMs}ms, after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}: ${describe(lastError)}`,
    );

  for (;;) {
    attempts += 1;

    // Raced against the deadline, because a connection attempt is not itself bounded: a host
    // that drops packets rather than refusing them leaves `connect` waiting on the operating
    // system's timeout, which is minutes. Both branches settle, so neither leaves a rejection
    // for someone else to find — and the losing timer is **cancelled**, because an armed
    // 30-second `setTimeout` holds the event loop open. A server that has just bound a port
    // would never notice; a script that called this and expected to exit would hang.
    const expiry = expiresIn(Math.max(deadline - Date.now(), 0));
    let outcome: "ready" | "expired" | { readonly cause: unknown };
    try {
      outcome = await Promise.race([
        probe(pool).then(
          () => "ready" as const,
          (cause: unknown) => ({ cause }),
        ),
        expiry.reached,
      ]);
    } finally {
      expiry.cancel();
    }

    if (outcome === "ready") {
      return { ok: true, attempts, waitedMs: Date.now() - started };
    }

    if (outcome === "expired") return gaveUp();

    lastError = outcome.cause;

    if (!waitingMightFix(lastError)) {
      return refused(
        `the database refused the connection, and waiting would not change that: ${describe(lastError)}`,
      );
    }

    // Announced only once this is going to be a wait. Said before the check above, it would
    // claim a boot was waiting for a database that had just refused it outright.
    if (attempts === 1) {
      options.onWaiting?.({ attempt: attempts, message: describe(lastError) });
    }

    if (Date.now() >= deadline) return gaveUp();
    await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 0)));
  }
}

/** One connection, taken and given straight back. `select 1` is the cheapest real query. */
async function probe(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select 1");
  } finally {
    client.release();
  }
}

/**
 * The leaves of an error, because Node hands connection failures over as an `AggregateError`
 * whenever a host resolves to more than one address — a bare `.message` on one of those is
 * the empty string, and a bare `.code` is `undefined`.
 */
function leavesOf(cause: unknown): unknown[] {
  if (cause instanceof AggregateError) return cause.errors.flatMap(leavesOf);
  return [cause];
}

function describe(cause: unknown): string {
  const messages = leavesOf(cause)
    .map((leaf) => (leaf instanceof Error ? leaf.message : String(leaf)))
    .filter((message) => message.length > 0);
  return messages.length > 0 ? [...new Set(messages)].join("; ") : String(cause);
}

/**
 * Retried only when every leaf says so. An error carrying no code at all is not retried:
 * something unrecognised is more likely to be a deployment that will never work than a
 * database that is a second late, and the loud version of that guess is the cheap one.
 */
function waitingMightFix(cause: unknown): boolean {
  const codes = leavesOf(cause).flatMap((leaf) => {
    const code = (leaf as { code?: unknown } | null)?.code;
    return typeof code === "string" ? [code] : [];
  });
  return codes.length > 0 && codes.every((code) => WAITING_MIGHT_FIX.has(code));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The deadline, as something that can be stood down when the attempt beat it. */
function expiresIn(ms: number): {
  readonly reached: Promise<"expired">;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout>;
  const reached = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), ms);
  });
  return { reached, cancel: () => clearTimeout(timer) };
}
