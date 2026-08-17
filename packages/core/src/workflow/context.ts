import type { Database } from "../db/client.ts";

/**
 * What a Step runs against — the Workflow's context, and it is **open** (ADR-0013).
 *
 * `metadata` is the openness. Core writes into it and never reads from it: whatever the
 * caller sent that Core does not model arrives here verbatim, so a Project's Step can read
 * data Core has never heard of. ADR-0013 is explicit that this cannot be a closed typed
 * struct — if it were, lead-time pricing would be impossible without changing Core, and the
 * flagship mechanism would fail its first real test. The cost is type safety at this one
 * boundary, paid deliberately.
 */
export type WorkflowContext = {
  readonly db: Database;
  /** Untyped by design. Core never reads a key out of this. */
  readonly metadata: Readonly<Record<string, unknown>>;
};

/**
 * The open half of a context, read off a request's query string.
 *
 * This is ADR-0013's openness made real at the edge rather than only in the types. The
 * store surface's price route models nothing in the query string — the Variant is in the
 * path — so every parameter here is by definition something Core has never heard of, and it
 * is carried through verbatim for a Project's Step to read. Lead-time pricing is the case
 * that ADR names, and it must be reachable *without changing Core*: if a Developer had to
 * add a parameter to a Core route to get their own input to their own Step, the extension
 * surface would be wrong.
 *
 * Values arrive as strings and are not parsed, because parsing implies a shape and Core has
 * no business having an opinion about the shape of an input it does not model. A repeated
 * parameter keeps its last value — an array for some keys and a string for others would be a
 * shape too.
 *
 * A route that one day *does* model a query parameter must take it out of what it passes
 * here, or Core would start reading a key out of the open half and the openness would
 * quietly become a schema.
 */
export function openMetadata(url: URL): Record<string, unknown> {
  return Object.fromEntries(url.searchParams);
}
