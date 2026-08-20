import { desc, eq } from "drizzle-orm";
import type { Database, Queryable } from "../db/client.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
import { channel } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import {
  type Changes,
  changesFrom,
  changesNothing,
  mustBeText,
  notUsable,
  openData,
  text,
} from "../patch.ts";

/**
 * Channels: making one, reading them, renaming one, removing one (#291, ADR-0005).
 *
 * A **Channel** is a route to market — a storefront, a marketplace listing — and ADR-0005 says
 * that is the whole of what it means: *kobai's Channel means sales channel only*, against
 * Vendure's, which overloads the same word to mean tenant boundary and is a known source of
 * confusion. So this table is a name, and the module is the thinnest CRUD in the repository.
 *
 * Two things about it are decisions rather than implementation:
 *
 * **A Channel references nothing and is referenced by one column.** `core_api_key.channel_id` is
 * the binding, because which Channel a request is in is decided by the credential it presented
 * (ADR-0020) rather than threaded through every request — so a storefront cannot claim to be in
 * a Channel it was not issued a key for. `channel.test.ts` asks `foreignKeysTargeting` what
 * points here, so a later scoping key reddens the build instead of arriving unnoticed.
 *
 * **Deleting one is refused for nothing**, which is `DELETE /admin/collections/{id}`'s judgement
 * at a different table and for its reason: what a Channel holds is keys, and a key whose Channel
 * has gone is `null` — the unconstrained key every key was before Channels existed — rather than
 * a credential that has lost something. Refusing while keys named it would be worse than
 * useless: revocation is a column rather than a delete, so a revoked key keeps its row forever
 * and a Channel any key had ever named could never be removed at all.
 */

/** The one word a Channel operation is refused with, past the request's own two. */
export const CHANNEL_NOT_FOUND = "channel-not-found";

/** A Channel as the admin surface reports it — the whole row, minus what nobody reads. */
export type Channel = {
  readonly id: string;
  readonly name: string;
  readonly metadata: Record<string, unknown>;
};

export type ChannelCreation =
  | { readonly ok: true; readonly channel: Channel }
  | { readonly ok: false; readonly reason: "invalid"; readonly detail: string };

export type ChannelUpdate =
  | { readonly ok: true; readonly channel: Channel }
  | {
      readonly ok: false;
      readonly reason: "invalid" | typeof CHANNEL_NOT_FOUND;
      readonly detail: string;
    };

/** Deleting a Channel refuses exactly one way: there is no such Channel. */
export type ChannelDeletion =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: typeof CHANNEL_NOT_FOUND;
      readonly detail: string;
    };

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type CreateChannelInput = {
  readonly name?: unknown;
  readonly metadata?: unknown;
};

export type UpdateChannelInput = CreateChannelInput;

/** The columns a body names, of which a `PATCH` names some and a create names all it means to. */
type ChannelColumns = {
  name: string;
  metadata: Record<string, unknown>;
};

/** Said once, because two paths reach it: a create naming no name, and either path given a blank. */
const NAME_MUST_BE_A_NAME = mustBeText("name");

/** The columns a Channel is reported by. Named once, because four queries answer with them. */
const REPORTED = {
  id: channel.id,
  name: channel.name,
  metadata: channel.metadata,
} as const;

export async function createChannel(
  db: Database,
  input: CreateChannelInput,
): Promise<ChannelCreation> {
  const usable = readChannelInput(input);
  if (!usable.ok) return usable;

  const { name, metadata = {} } = usable.changes;
  if (name === undefined) return notUsable(NAME_MUST_BE_A_NAME);

  const [created] = await db
    .insert(channel)
    .values({ name, metadata })
    .returning(REPORTED);
  // Unreachable — an `insert … returning` of one row answers with one row — and typed rather
  // than asserted away.
  if (!created) throw new Error("unreachable: creating a Channel answered no row");
  return { ok: true, channel: created };
}

/**
 * A page of Channels, newest first — the same ordering and the same cursor every other list on
 * this surface uses (ADR-0064), ending in `id` so it cannot tie.
 */
export async function listChannels(
  db: Database,
  page: PageRequest,
): Promise<Page<Channel>> {
  const rows = await db
    .select({ ...REPORTED, cursorAt: cursorAt(channel.createdAt) })
    .from(channel)
    .where(rowsAfter(page, channel.createdAt, channel.id))
    .orderBy(desc(channel.createdAt), desc(channel.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  // Field by field rather than by spread, so the column the cursor is cut from cannot reach a
  // response by being forgotten about.
  return {
    items: found.map((row) => ({
      id: row.id,
      name: row.name,
      metadata: row.metadata,
    })),
    nextCursor,
  };
}

/**
 * One Channel, or `undefined` when there is no such Channel — including when `id` is not an
 * identifier at all, which is the same answer to the caller.
 */
export async function readChannel(
  db: Queryable,
  id: string,
): Promise<Channel | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db
    .select(REPORTED)
    .from(channel)
    .where(eq(channel.id, id))
    .limit(1);
  return row;
}

/**
 * Renames a Channel, and replaces its metadata if it is named.
 *
 * The same `PATCH` every other correction on this surface is (ADR-0062). No lock and no
 * transaction: existence is what the `update` itself answers, and nothing about this row is read
 * before it is written.
 */
export async function updateChannel(
  db: Database,
  id: string,
  input: UpdateChannelInput,
): Promise<ChannelUpdate> {
  const usable = readChannelInput(input);
  if (!usable.ok) return usable;

  const changes = usable.changes;
  if (Object.keys(changes).length === 0) {
    return changesNothing(
      "a `name`, a `metadata`, or both",
      "Which API keys are in this Channel is not changed here: a key is bound to a Channel when it is minted, at `POST /admin/api-keys`.",
    );
  }

  if (!isUuid(id)) return noSuchChannel(id);

  const [updated] = await db
    .update(channel)
    .set(changes)
    .where(eq(channel.id, id))
    .returning(REPORTED);
  if (!updated) return noSuchChannel(id);
  return { ok: true, channel: updated };
}

/**
 * Deletes a Channel, and **every API key that named it keeps working**, unconstrained.
 *
 * `core_api_key.channel_id` is `on delete set null`, which is the whole of that — see this
 * module's header for why it is not `restrict`, and `db/schema.ts` for the column's own account
 * of it.
 */
export async function deleteChannel(db: Database, id: string): Promise<ChannelDeletion> {
  if (!isUuid(id)) return noSuchChannel(id);

  const [deleted] = await db
    .delete(channel)
    .where(eq(channel.id, id))
    .returning({ id: channel.id });
  if (!deleted) return noSuchChannel(id);
  return { ok: true };
}

/**
 * The columns a body names, narrowed — the one place a Channel's input is read, so creating one
 * and renaming one cannot disagree about what a name is.
 */
function readChannelInput(input: CreateChannelInput): Changes<ChannelColumns> {
  return changesFrom(
    { name: input.name, metadata: input.metadata },
    { name: text("name"), metadata: openData("metadata") },
  );
}

function noSuchChannel(id: string): {
  ok: false;
  reason: typeof CHANNEL_NOT_FOUND;
  detail: string;
} {
  return {
    ok: false,
    reason: CHANNEL_NOT_FOUND,
    detail: `No Channel with the identifier ${JSON.stringify(id)} exists. \`GET /admin/channels\` lists the ones this Store has.`,
  };
}

/**
 * The refusal for a `channelId` naming no Channel — or `undefined` where it names one.
 *
 * Exported because `POST /admin/api-keys` asks it: **422**, on `collection-not-found`'s
 * distinction — the body is well formed and what refuses it is the state of the Store — and the
 * same word `GET /admin/channels/{id}` answers 404 with, because one fact gets one word
 * (ADR-0060).
 */
export async function unknownChannel(
  db: Queryable,
  id: string,
): Promise<{ ok: false; reason: typeof CHANNEL_NOT_FOUND; detail: string } | undefined> {
  return (await readChannel(db, id)) === undefined ? noSuchChannel(id) : undefined;
}
