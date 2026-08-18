import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { idempotencyKey } from "../db/schema.ts";
import { type Order, readOrder } from "./read.ts";

/**
 * **Idempotency** — the client-supplied key that makes a retry safe (#102).
 *
 * A `POST /store/orders` that times out on the way back has still been served, and the retry
 * every HTTP client makes by itself would be a second Order: a second charge, and a second claim
 * on stock. Nothing in the request can say the two are one intention, because the difference is
 * on the network rather than in the body — so the caller names it, exactly as Stripe has clients
 * name theirs, and kobai already follows Stripe for the publishable/secret split (ADR-0020).
 *
 * **The key is claimed before the Workflow runs and completed after it.** That is the whole
 * mechanism, and the order is what makes it correct rather than approximately correct:
 *
 * - Claiming is one `insert … on conflict`, so of two simultaneous requests carrying one key
 *   exactly one gets to run. The other reads the row and is answered from it — with the Order,
 *   if the first has finished, and with a refusal if it has not.
 * - A run that was **refused** releases the key, because nothing was created for it to name. A
 *   storefront that fixes the Cart and retries is retrying the same intention, and a key held
 *   against a purchase that never happened would refuse it.
 * - A run that **captured** completes the key with the Order's identifier, and every later
 *   request carrying that key is answered with that Order rather than being allowed to place
 *   another.
 *
 * **This is not what stops two Orders coming from one Cart** — the unique index on
 * `core_order.cart_id` is, and it works whether a key was supplied or not (see
 * `cart/read.ts`). What a key adds is that the retry gets the Order back instead of a refusal,
 * which is what makes it indistinguishable from the response that went missing.
 *
 * **A key is deployment-wide, and needs no narrower scope.** One deployment is one Store
 * (ADR-0005), and a key on its own opens nothing: the only thing it can be answered with is the
 * Order placed for the very request it was first used with, and that request names a Cart whose
 * identifier is already the whole of the authority over it (ADR-0020). So two storefronts that
 * happen to choose one key are refused as a reuse rather than shown each other's Orders, and
 * the pair that is *not* refused is the pair that were placing the same Cart anyway.
 */

/**
 * How long a key binds.
 *
 * Long enough to cover every retry a storefront or its client library will make, and short
 * enough that a key held by a process that died mid-run frees itself the same day. Twenty-four
 * hours is Stripe's window, and there is no reason here to be more inventive than that.
 */
const KEY_LIFETIME = "24 hours";

/** Core's own reasons for turning a request back on the strength of its key. */
export type IdempotencyRefusal = "idempotency-key-reused" | "idempotency-key-in-progress";

/**
 * What a claim can be, and the reason it is a union rather than a boolean with fields.
 *
 * Each arm is a different thing for the route to do — run, answer with an Order it already has,
 * or refuse — and there is no reading of one arm's fields that makes sense on another. The
 * caller cannot forget the replay, because there is no Order to answer with until `outcome` has
 * been narrowed.
 */
export type IdempotencyClaim =
  | {
      readonly outcome: "claimed";
      /** The Order this key produced. Call it once the Order exists. */
      complete(orderId: string): Promise<void>;
      /** Give the key back, for a run that created nothing. */
      release(): Promise<void>;
    }
  | { readonly outcome: "replayed"; readonly order: Order }
  | {
      readonly outcome: "refused";
      readonly reason: IdempotencyRefusal;
      readonly detail: string;
    };

/**
 * Claims `key` for the request described by `request`, or says what to answer instead.
 *
 * A caller that supplied no key gets a claim that owns nothing and does nothing — so the route
 * has one path rather than two, and the request without a key is the one where every step of
 * this is a no-op rather than a branch somebody has to remember.
 */
export async function claimIdempotencyKey(
  db: Database,
  key: string | undefined,
  request: unknown,
): Promise<IdempotencyClaim> {
  if (key === undefined) return unclaimed;

  const fingerprint = fingerprintOf(request);
  const lifetime = sql`now() + ${KEY_LIFETIME}::interval`;

  // The claim, as one statement. A key nobody holds is inserted; one whose holder has expired
  // is taken over; one that is live and held conflicts and updates nothing, which is what
  // leaves `returning` empty. Reading first and inserting second is the version of this that
  // two simultaneous requests both win.
  const [claimed] = await db
    .insert(idempotencyKey)
    .values({ key, fingerprint, expiresAt: lifetime })
    .onConflictDoUpdate({
      target: idempotencyKey.key,
      set: { fingerprint, orderId: null, expiresAt: lifetime, createdAt: sql`now()` },
      setWhere: sql`${idempotencyKey.expiresAt} < now()`,
    })
    .returning({ id: idempotencyKey.id });
  if (claimed) return holding(db, key);

  const [held] = await db
    .select({ fingerprint: idempotencyKey.fingerprint, orderId: idempotencyKey.orderId })
    .from(idempotencyKey)
    .where(eq(idempotencyKey.key, key))
    .limit(1);
  // Gone between the two statements, which means the request holding it released it just then.
  // Answered as in-flight rather than run, because retrying is the fix either way and this is
  // the one answer that cannot be wrong about what the other request did.
  if (!held) return inProgress(key);

  if (held.fingerprint !== fingerprint) {
    return {
      outcome: "refused",
      reason: "idempotency-key-reused",
      detail: `Idempotency key ${JSON.stringify(key)} was already used for a different request. A key stands for one intention, so answering this one with the Order that key already placed would be answering a question nobody asked — use a new key for a new purchase.`,
    };
  }

  if (held.orderId === null) return inProgress(key);

  const order = await readOrder(db, held.orderId);
  if (!order) {
    throw new Error(
      `Idempotency key ${JSON.stringify(key)} names an Order that is not there. The key's row is cascaded from the Order, so this should not be reachable.`,
    );
  }
  return { outcome: "replayed", order };
}

/** The claim a request that named no key gets: it owns nothing, so it gives nothing back. */
const unclaimed: IdempotencyClaim = {
  outcome: "claimed",
  complete: () => Promise.resolve(),
  release: () => Promise.resolve(),
};

/** The claim this request now holds, and the two ways it can end. */
function holding(db: Database, key: string): IdempotencyClaim {
  return {
    outcome: "claimed",
    async complete(orderId) {
      await db.update(idempotencyKey).set({ orderId }).where(eq(idempotencyKey.key, key));
    },
    async release() {
      // `order_id is null` so that releasing can never delete a completed key — the one write
      // here that would turn a safe retry back into a second Order.
      await db
        .delete(idempotencyKey)
        .where(sql`${idempotencyKey.key} = ${key} and ${idempotencyKey.orderId} is null`);
    },
  };
}

function inProgress(key: string): IdempotencyClaim {
  return {
    outcome: "refused",
    reason: "idempotency-key-in-progress",
    detail: `Another request carrying idempotency key ${JSON.stringify(key)} is still being served. Nothing has been placed twice; wait and ask again, and this key will answer with the Order that request produces.`,
  };
}

/**
 * A digest of what was asked for, so the same key used for something else can be told apart.
 *
 * Canonical rather than literal: two requests differing only in whitespace or key order are the
 * same request, and a storefront that re-serialised its body between the attempt and the retry
 * would otherwise be told it had reused its key. The value is hashed because comparing is all it
 * is for — a stored copy of every request body would be a second place a Shopper's data lives.
 */
function fingerprintOf(request: unknown): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

/** JSON with every object's keys in a fixed order, so equal requests have equal text. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value)
    .filter(([, held]) => held !== undefined)
    .sort(([one], [other]) => (one < other ? -1 : 1))
    .map(([name, held]) => `${JSON.stringify(name)}:${canonical(held)}`);
  return `{${entries.join(",")}}`;
}
