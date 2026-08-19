/**
 * The slug this Admin shows a Merchant while they type a title, as the handle it is about to
 * ask kobai for.
 *
 * A copy of the reduction `@kobai/core`'s `catalog/handle.ts` performs, and it is here for the
 * one thing a copy is allowed to be: an **affordance** (ADR-0063). kobai proposes a handle
 * itself for a create that names none, so the Admin needs no rule at all to make a Product —
 * what it needs is to show a Merchant, before they submit, what the address is going to be, and
 * to let them change it there. A round trip per keystroke is not that.
 *
 * **`slugify` and deliberately not `proposeHandle`, which is the name Core uses one door
 * along.** Core's `proposeHandle` answers `undefined` for a title that reduces to nothing or to
 * something that reads as an identifier, because it is *deciding*; this only reduces, and
 * answers `""` for the first and the identifier itself for the second. Sharing the name would
 * invite a reader to assume the two agree about exactly the inputs where they do not. **Nothing
 * holds this copy to Core's** — the SQL copy in `0037` earned a test for that drift and this one
 * has none — and it needs nothing, because of what follows.
 *
 * Three things, and they are what keep this from being a second copy of a *rule*:
 *
 * - **kobai decides.** Whatever is typed goes to `POST /admin/products` and is judged there. If
 *   this ever disagreed with Core, the Merchant would be told by a refusal rendered at the
 *   field, which is the same thing that happens when they type an address somebody else holds.
 *   The identifier-shaped case is exactly that: this proposes it, kobai refuses it, and the
 *   Merchant is told why.
 * - **It proposes and never corrects.** A Merchant who edits the box owns it from then on —
 *   the caller stops writing into it — so nothing a Merchant typed is silently rewritten.
 * - **An empty answer is left empty**, and the field is then sent as absent rather than as
 *   `""`. A title with nothing addressable in it is a real title, and kobai's refusal names the
 *   remedy better than a guess made here would.
 *
 * This is the same line `lib/permissions.ts` draws for a permission check and `refusal.ts`'s
 * `Record`s draw for a closed family: the Admin may hold what kobai's own contract fixes, and
 * must ask about what a deployment decides. Which addresses are **taken** is a deployment's
 * fact, and nothing here predicts it.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}
