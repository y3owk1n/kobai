import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { merchant, role, session } from "../db/schema.ts";
import type { MerchantIdentity, RoleSummary } from "./identity.ts";
import type { Permission } from "./permissions.ts";

/**
 * Sessions: minting one, resolving one, ending one.
 *
 * The token is 256 bits from the platform CSPRNG — not derived from the Merchant, not
 * sequential, and not guessable at any rate an attacker can sustain. What kobai stores is a
 * SHA-256 of it, so the table is not a list of credentials. SHA-256 rather than argon2 here
 * on purpose: the input already has full entropy, so there is nothing to brute-force and
 * nothing for a slow hash to buy, while a slow hash on the read path would tax every request.
 *
 * How the token reaches a request is not this module's business — it is `session-cookie.ts`'s,
 * and since ADR-0032 the answer is an httpOnly cookie rather than a bearer header.
 */

/**
 * **How long a session survives with nobody using it, for a Project that says nothing.** This
 * is the number a Developer wants, and the only one that decides when a Merchant at their desk
 * is signed out.
 *
 * Sliding rather than absolute (ADR-0045). Spec story 49 asks to be signed out "so that an
 * unattended browser is not an open door", and an expiry fixed at sign-in answers the letter
 * of that and inverts the spirit: it signs out a Merchant who has been working in the Admin
 * all day, while a browser abandoned ten minutes after sign-in stays open until evening. What
 * closes the door is measuring from the *last request*, which is what this window does.
 *
 * Thirty minutes is OWASP's recommendation for an application of this sensitivity, and it is
 * short only for a session nobody is using — an active Merchant never meets it. It is now a
 * *default* rather than the rule: a deployment with a different risk profile sets its own in
 * `kobai.config.ts` (ADR-0050), and one that says nothing gets exactly this.
 */
export const DEFAULT_SESSION_IDLE_WINDOW_MS = 30 * 60 * 1000;

/**
 * **The longest a session can live however hard it is used**, measured from sign-in.
 *
 * The cap is the answer to the obvious objection to a sliding window: a session that activity
 * extends is a session that never ends, so a token stolen from a browser is worth an
 * indefinite stay as long as the thief keeps using it. The idle window alone protects against
 * *abandonment*, not against theft. This bounds what a stolen token buys and puts a floor
 * under how often credentials are proved again.
 *
 * Twelve hours, which is #4's original lifetime kept in its new job: the number that used to
 * be the whole rule is now the ceiling over it, so no deployment's sessions live longer than
 * they did before this changed.
 *
 * **Core's, not a Project's** (ADR-0050). The idle window above is configurable and this is
 * not: the window is what a deployment's own working day argues about, and the cap is the one
 * bound that survives a Merchant's traffic being someone else's. Nothing a Project sets moves
 * it, and the idle window is refused if it is longer than this.
 */
export const SESSION_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * How far the deadline must have fallen behind before a request writes a new one.
 *
 * This is the whole of the write pattern, and it is why a sliding window is not a write per
 * request: a request extends the session only when the stored deadline is at least this stale,
 * so a session serves at most one `UPDATE` a minute however many requests the Admin fires. The
 * cost is paid in precision rather than in safety — the deadline a Merchant actually gets is
 * somewhere in `[idle window − this, idle window]`, so the guarantee to state is the lower
 * end: **an idle window less this always survives, and a whole one never does — until the cap
 * intervenes, which it does for nothing this interval decides.** At the default window that is
 * the sentence ADR-0045 wrote: twenty-nine minutes always survive, thirty always do not.
 *
 * The caveat is not new and is worth stating out loud now the window is a Project's. The cap
 * is not a window and nothing extends it, so a session in its last ten minutes gets ten
 * minutes whatever the idle window says — and a Project that sets a window *at* the cap has
 * asked for a deployment where the cap is the only thing left. See ADR-0050.
 *
 * **It stays a fixed minute while the window moves** (ADR-0050). Deriving it from the window
 * — a thirtieth of it, which is what a minute is against thirty minutes — would keep the
 * precision proportional and spend the property this exists for: a Project setting a
 * five-minute window would buy six times the writes. One `UPDATE` a minute per session is the
 * bound worth keeping absolute, and {@link MINIMUM_SESSION_IDLE_WINDOW_MS} is what keeps the
 * precision it spends from ever being most of the window.
 */
export const SESSION_EXTENSION_INTERVAL_MS = 60 * 1000;

/**
 * The shortest idle window a Project may set — two minutes, and the reason is arithmetic
 * rather than taste.
 *
 * The write pattern spends up to {@link SESSION_EXTENSION_INTERVAL_MS} of the window on
 * precision, so a window at this floor still guarantees half of itself and every longer one
 * guarantees more. Below it the guarantee shrinks towards nothing, and at exactly a minute it
 * *is* nothing: no request would ever be stale enough to write, so the first deadline a
 * session was minted with would also be its last and a Merchant clicking steadily would be
 * signed out mid-sentence. That is not a shorter window, it is a broken one.
 */
export const MINIMUM_SESSION_IDLE_WINDOW_MS = 2 * SESSION_EXTENSION_INTERVAL_MS;

/**
 * What a deployment has decided about how long its sessions live.
 *
 * One object rather than a number, because the *cap* is part of the answer even though no
 * Project may move it: everything that computes a deadline needs both, and reading one from
 * an argument and the other from a module constant is how the two drift apart. It is built
 * once, at boot, by {@link resolveSessionPolicy}, and is the only lifetime any of the
 * functions below consult.
 */
export type SessionPolicy = {
  /** How long a session survives with nobody using it. */
  readonly idleWindowMs: number;
  /** The longest it can live however hard it is used, measured from sign-in. */
  readonly absoluteLifetimeMs: number;
};

/**
 * What a Project may say about its sessions, as `kobai.config.ts` carries it.
 *
 * Declared here rather than in `config.ts` because this module owns the numbers and the rules
 * about them — `config.ts` is the shape of the file, not the authority on what a session is.
 * The cap is deliberately absent: see {@link SESSION_ABSOLUTE_LIFETIME_MS}.
 */
export type SessionOptions = {
  /**
   * **How long a session survives with nobody using it.** Defaults to thirty minutes.
   *
   * Between {@link MINIMUM_SESSION_IDLE_WINDOW_MS} and
   * {@link SESSION_ABSOLUTE_LIFETIME_MS} inclusive, as a whole number of milliseconds. A
   * value outside that stops the boot rather than being clamped to fit — see
   * {@link resolveSessionPolicy}.
   *
   * ```ts
   * session: { idleWindowMs: 45 * 60 * 1000 }
   * ```
   *
   * **A window near the cap is mostly the cap.** The two deadlines are enforced as the
   * earlier of the pair, so the longer this is set the less of it a session ever sees, and
   * set *at* the cap it is inert: every deadline is pinned at sign-in plus twelve hours from
   * the moment the session is minted, no extension is ever written, and the deployment has no
   * idle expiry at all. That is arithmetic rather than a trap, and it is what a Project
   * asking for a twelve-hour idle window has asked for — but it is worth knowing before
   * asking (ADR-0050).
   */
  readonly idleWindowMs?: number;
};

/** What a Project that configures nothing gets: ADR-0045's two numbers, unchanged. */
export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleWindowMs: DEFAULT_SESSION_IDLE_WINDOW_MS,
  absoluteLifetimeMs: SESSION_ABSOLUTE_LIFETIME_MS,
};

/**
 * Turns what a Project wrote into the policy this module enforces, or **stops the boot**.
 *
 * Called by `createKobai` before anything is opened, so an unusable window is a process that
 * never serves rather than one serving sessions on a number nobody chose. Throwing is right
 * where a failed migration returns an outcome (#2): a migration fails for reasons a running
 * deployment can meet and has to be reportable on `/health`, whereas this is a value in a
 * file a Developer just wrote, wrong on every boot until it is fixed, and there is nothing a
 * caller could usefully do with it but stop. The message names the key, the value it was
 * given and the bound it missed, because "invalid configuration" is not a diagnosis.
 *
 * **Nothing is clamped.** A window silently pulled up to two minutes or down to twelve hours
 * is a deployment whose sessions do not last what its config file says they last, and the
 * mistake would be discovered by a Merchant rather than by the Developer who made it.
 */
export function resolveSessionPolicy(options?: SessionOptions): SessionPolicy {
  /** Where a Developer has to go to fix it, spelled the way they wrote it. */
  const IDLE_WINDOW_SETTING = "`session.idleWindowMs` in kobai.config.ts";

  const idleWindowMs = options?.idleWindowMs;
  if (idleWindowMs === undefined) return DEFAULT_SESSION_POLICY;

  if (!Number.isSafeInteger(idleWindowMs)) {
    throw new Error(
      `${IDLE_WINDOW_SETTING} must be a whole number of milliseconds, and is ${idleWindowMs}.`,
    );
  }
  if (idleWindowMs < MINIMUM_SESSION_IDLE_WINDOW_MS) {
    throw new Error(
      `${IDLE_WINDOW_SETTING} must be at least ${MINIMUM_SESSION_IDLE_WINDOW_MS} (two minutes), and is ${idleWindowMs}. A session's deadline is written at most once a minute, so a window shorter than this would spend most of itself on that — and one of a minute or less would never be written at all, signing out a Merchant who was still clicking.`,
    );
  }
  if (idleWindowMs > SESSION_ABSOLUTE_LIFETIME_MS) {
    throw new Error(
      `${IDLE_WINDOW_SETTING} must be at most ${SESSION_ABSOLUTE_LIFETIME_MS} (twelve hours), and is ${idleWindowMs}. No session outlives that cap however hard it is used, so an idle window past it is one no session could ever reach. The cap is Core's, and a Project does not set it (ADR-0050).`,
    );
  }

  return { idleWindowMs, absoluteLifetimeMs: SESSION_ABSOLUTE_LIFETIME_MS };
}

const TOKEN_BYTES = 32;

/**
 * What a sign-in hands back.
 *
 * The token goes straight into the `Set-Cookie` header and into nothing else — no response
 * body carries it, which is the exposure ADR-0032 closed.
 */
export type IssuedSession = {
  readonly token: string;
  readonly expiresAt: Date;
};

/** Who is making an admin request, and what they are allowed to do. */
export type Authenticated = {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly merchant: MerchantIdentity;
  readonly role: RoleSummary;
};

/**
 * Why an admin request is not authenticated.
 *
 * `expired` is distinct from `unknown` on purpose. An expired session means the Merchant was
 * signed in and now is not, and they are told so — the alternative, treating them as
 * anonymous, is the silent degradation ADR-0010's Admin would render as an empty page rather
 * than as a sign-in prompt.
 */
export type SessionRejection = "missing" | "malformed" | "unknown" | "expired";

export type SessionLookup =
  | { readonly ok: true; readonly auth: Authenticated }
  | { readonly ok: false; readonly reason: SessionRejection };

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issues a session for a Merchant, good for one of `policy`'s idle windows of quiet.
 *
 * Signing in also clears that Merchant's sessions that have already run out. Housekeeping
 * rather than enforcement — {@link resolveSession} refuses an expired session whether or not
 * this has run — but it is what keeps the table from growing forever in a deployment whose
 * Merchants close the tab instead of signing out, without a sweeper nobody has asked for.
 *
 * The sweep asks only about `expires_at` and still catches a session that ran into the
 * absolute cap, because nothing ever writes a deadline beyond it: the cap is the ceiling on
 * every value {@link extendedDeadline} produces, so a session past its cap is a session whose
 * `expires_at` is already behind.
 */
export async function createSession(
  db: Database,
  merchantId: string,
  policy: SessionPolicy,
): Promise<IssuedSession> {
  const now = new Date();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  // Issued at `now`, so the cap is measured from `now` too — which is what makes this the
  // same arithmetic every later extension does, rather than a second rule for the first one.
  const expiresAt = extendedDeadline(now, now, policy);

  await db
    .delete(session)
    .where(and(eq(session.merchantId, merchantId), lt(session.expiresAt, now)));

  await db
    .insert(session)
    .values({ merchantId, tokenHash: hashSessionToken(token), expiresAt });

  return { token, expiresAt };
}

/**
 * Resolves a token into the Merchant and Role behind it — **and, if it is live, extends it.**
 *
 * Resolving is the only thing that happens on every authenticated request, so it is where the
 * idle window is kept open; a separate `extendSession` for the gate to call would be a step a
 * future caller could forget, and forgetting it signs a working Merchant out. The extension is
 * the one write on this path and it is rate-limited — see {@link slideDeadline}.
 *
 * An expired session is reported as expired every time it is presented, not once. The row is
 * deliberately **not** deleted here: deleting it would make the second request with the same
 * token look like a session that never existed, so an Admin firing several requests on page
 * load would be told "signed out" for one of them and "never signed in" for the rest. Being
 * told you have been signed out is the behaviour the ticket asks for, and it has to be the
 * answer every time. The row is cleared on the Merchant's next sign-in.
 */
export async function resolveSession(
  db: Database,
  token: string,
  policy: SessionPolicy,
): Promise<SessionLookup> {
  const [row] = await db
    .select({
      sessionId: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      merchantId: merchant.id,
      email: merchant.email,
      roleName: role.name,
      permissions: role.permissions,
    })
    .from(session)
    .innerJoin(merchant, eq(merchant.id, session.merchantId))
    .innerJoin(role, eq(role.id, merchant.roleId))
    .where(eq(session.tokenHash, hashSessionToken(token)))
    .limit(1);

  if (!row) return { ok: false, reason: "unknown" };

  const now = new Date();
  const deadline = deadlineOf(row, policy);
  if (now.getTime() >= deadline.getTime()) return { ok: false, reason: "expired" };

  return {
    ok: true,
    auth: {
      sessionId: row.sessionId,
      expiresAt: await slideDeadline(db, row, deadline, now, policy),
      merchant: { id: row.merchantId, email: row.email },
      role: { name: row.roleName, permissions: row.permissions },
    },
  };
}

/**
 * When a session is over: the earlier of running out of idle window and hitting the cap.
 *
 * Both are asked on the read path, rather than trusting `expires_at` to have been clamped
 * when it was written. The clamp is real ({@link extendedDeadline}) and this makes the cap a
 * property of *reading* a session anyway — the same reason an expired row is refused here
 * whether or not sign-in's housekeeping ever swept it. A rule enforced only by whoever last
 * wrote the row is a rule a hand-run `UPDATE` can lift, and under ADR-0004 Core is not the
 * only writer this database has.
 */
function deadlineOf(
  row: { createdAt: Date; expiresAt: Date },
  policy: SessionPolicy,
): Date {
  return new Date(Math.min(row.expiresAt.getTime(), capOf(row.createdAt, policy)));
}

/** A fresh deadline for a session signed in at `createdAt`, never past its cap. */
function extendedDeadline(createdAt: Date, now: Date, policy: SessionPolicy): Date {
  return new Date(
    Math.min(now.getTime() + policy.idleWindowMs, capOf(createdAt, policy)),
  );
}

/**
 * The instant a session signed in at `createdAt` ends however hard it is used.
 *
 * One function rather than the same sum in both callers, because the *anchor* is the decision
 * — the cap is measured from sign-in and not from the last request, which is the whole of what
 * makes it a cap — and a decision belongs in one place.
 */
function capOf(createdAt: Date, policy: SessionPolicy): number {
  return createdAt.getTime() + policy.absoluteLifetimeMs;
}

/**
 * Slides the deadline, and usually writes nothing at all. Answers with the deadline that now
 * stands, which is what the Merchant is told and what the next gate will enforce.
 *
 * **The write pattern in one condition.** A new deadline is written only once it is
 * {@link SESSION_EXTENSION_INTERVAL_MS} ahead of the stored one, so a session costs at most
 * one `UPDATE` a minute no matter how many requests the Admin makes — and the busiest session
 * in a deployment is the cheapest per request. The same condition retires the write entirely
 * near the cap: once the clamp holds the new deadline still, it stops being far enough ahead
 * and there is nothing left to write.
 *
 * **It slides both ways.** A stored deadline *further* out than a whole idle window is one
 * this code did not write — a session minted under #4's flat twelve hours, found in the table
 * by the deployment that introduced the window, or a hand-run `UPDATE`. It is pulled in on
 * first use rather than left to run out its original lifetime, because a session nobody can
 * sign out by walking away is the exact bug the window exists to fix, and "for another twelve
 * hours after the upgrade" is not an answer.
 *
 * The `expires_at` guard on the `UPDATE` bounds what a write can do, not what this answers: it
 * cannot revive a session that lapsed between the read and the write, and it matches no row at
 * all when a concurrent sign-out has already deleted one. The request in flight was authorised
 * by the read a moment earlier and stays authorised — what it does not do is leave a deadline
 * behind for the next one.
 */
async function slideDeadline(
  db: Database,
  row: { sessionId: string; createdAt: Date; expiresAt: Date },
  deadline: Date,
  now: Date,
  policy: SessionPolicy,
): Promise<Date> {
  const slid = extendedDeadline(row.createdAt, now, policy);
  // Measured against the column rather than against `deadline`, because the column is what a
  // write would change and the question here is only whether one is worth making.
  const ahead = slid.getTime() - row.expiresAt.getTime();
  if (ahead >= 0 && ahead < SESSION_EXTENSION_INTERVAL_MS) return deadline;

  const [updated] = await db
    .update(session)
    .set({ expiresAt: slid })
    .where(and(eq(session.id, row.sessionId), gt(session.expiresAt, now)))
    .returning({ expiresAt: session.expiresAt });

  return updated?.expiresAt ?? deadline;
}

/** Ends a session. The row goes, so the token stops working on the very next request. */
export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(session).where(eq(session.id, sessionId));
}

export function holdsPermission(auth: Authenticated, permission: Permission): boolean {
  return auth.role.permissions.includes(permission);
}
