/**
 * Narrowing what arrived as a JSON body.
 *
 * Every write path in Core takes its input as `unknown` and narrows it in one place, because
 * a request is bytes until something has looked at it. The route's Zod schema has already
 * said the body is *structurally* the right shape; these are the small, shared questions that
 * come up on the way to the rule a module actually owns — is this a non-empty string, is this
 * a JSON object — and they live here rather than once per module so that two modules cannot
 * answer them differently.
 *
 * What does **not** belong here is any rule: whether a SKU is taken, whether this Store prices
 * in that currency, whether a Variant is sellable. Those stay in the module that owns them and
 * answer with their own `reason` (see `http/contract.ts`).
 */

/** A non-empty string, trimmed, or `undefined` when it is neither. */
export function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result === "" ? undefined : result;
}

/** A JSON object — not an array, not null, not a primitive. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ADR-0004's escape hatch, on the way in: any JSON object, absent meaning `{}`.
 *
 * Nothing is validated beyond "it is an object", which is the point — a shape here would be
 * a promise, and a Plugin that needs a promise needs its own table. `undefined` means the
 * caller sent something that is not an object at all.
 */
export function asMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return {};
  return isJsonObject(value) ? value : undefined;
}

export function metadataDetail(what: string): string {
  return `${what} must be a JSON object. It is unindexed and untyped by design — anything needing an index or a type needs its own table.`;
}
