import { useSession } from "@/lib/session";

/**
 * What this Merchant's Role may do, and how the Admin offers it.
 *
 * **Everything in this file is an affordance and none of it is a boundary** (ADR-0063). The
 * enforcement is `requirePermission` in Core, which answers 403 before a handler runs and knows
 * nothing about this browser; what happens here is only that the Admin stops offering a
 * Merchant things their Role cannot do, and says why. Read a check below as security work and
 * two wrong conclusions follow immediately — that a cached answer is a hole, and that widening
 * it here would widen what a Merchant can actually do. Neither is true, and the second is the
 * dangerous one: **removing a check here removes a courtesy, and adding one grants nothing.**
 *
 * That is also why the session query behind this is deliberately never fresh. A Role edited
 * under a live session leaves these answers stale, and stale here means the Admin offers a
 * button kobai will refuse — a bad screen rather than an open door. `lib/session.tsx` re-reads
 * it on window focus and on navigation for exactly that reason.
 *
 * **The set of Permissions is open.** `Session`'s own description says a deployment "may hold a
 * permission this build of Core has never heard of" — a Plugin's, a later Core's — so a Role's
 * permissions arrive as `string[]` and are asked by **membership**. Never a union type, never a
 * `switch`: both would be this Admin claiming to know the whole vocabulary, and both would turn
 * a deployment's own word into a compile error or a dead arm.
 *
 * The two halves of ADR-0063's decision are split by *what a Merchant can learn from what they
 * are shown*:
 *
 * - **A section they cannot read is hidden** — `lib/sections.ts` narrows the one list — because
 *   a screen that 403s on load teaches nothing.
 * - **An action they cannot perform is shown, unavailable, and explained**, through
 *   {@link useUnavailable} and `components/action-button.tsx`. Hiding it would make the Admin
 *   lie about what kobai does: a Merchant who cannot see that Products are creatable has no way
 *   to learn that the Permission is a thing to ask for.
 */

/**
 * The Permissions the Admin's own screens read, spelled as kobai spells them.
 *
 * A short list, and deliberately not a copy of Core's: it names the ones some control in this
 * Admin is gated on and nothing else. It is `string` rather than anything narrower because the
 * set is open — see the note above — so this is a spelling aid, not a vocabulary.
 */
export const PERMISSIONS = {
  catalogRead: "catalog:read",
  catalogWrite: "catalog:write",
  orderRead: "order:read",
  apiKeyRead: "api-key:read",
  apiKeyWrite: "api-key:write",
} as const satisfies Record<string, string>;

/**
 * What this Merchant's Role holds, straight off the cached session.
 *
 * Empty for a Merchant who is not signed in, which is not a state any caller of this reaches:
 * every screen renders under the gate in `app.tsx`, which shows the sign-in form instead when
 * there is no session. Answering `[]` rather than throwing keeps that an invariant of the frame
 * rather than something each caller re-checks.
 */
export function usePermissions(): readonly string[] {
  return useSession().data?.role.permissions ?? [];
}

/**
 * Whether the Role holds one — membership on an open set, never a narrowing.
 *
 * Not exported, because nothing here wants a bare boolean: every caller wants the *sentence*,
 * which is {@link useUnavailable}. Export it the day a screen needs to decide something other
 * than whether a control is available.
 */
function useMay(permission: string): boolean {
  return usePermissions().includes(permission);
}

/**
 * Why a control is unavailable to this Merchant, or `null` when it is not.
 *
 * Shaped to be handed straight to `ActionButton`'s `unavailable`, so a screen asks once and
 * both the affordance and the sentence come from the one answer.
 *
 * `action` completes "Your Role cannot …", so it is a verb phrase — `create a Product`, `mint a
 * key`. The Permission is named in the sentence on purpose: a Merchant who has to ask a
 * colleague for it can then say which word they need, and the colleague administering Roles is
 * choosing from exactly these strings.
 */
export function useUnavailable(permission: string, action: string): string | null {
  return useMay(permission)
    ? null
    : `Your Role cannot ${action}: it does not hold "${permission}". A Merchant who administers access can add it.`;
}
