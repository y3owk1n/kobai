import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { LinkButton } from "@/components/link-button";
import { Button } from "@/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";

/**
 * Paging a list, with the cursor in the URL.
 *
 * kobai's lists are cursor-paged and there are no page numbers anywhere, on purpose
 * (ADR-0064): `?limit=` and `?after=`, an **opaque** `nextCursor`, and its absence as the only
 * end-of-list signal. So this offers next and previous and nothing else — there is no "page 3
 * of 12" to offer, and there is no total to count.
 *
 * **The cursor goes in the query string**, which is the whole point: a page is a URL a Merchant
 * can send to somebody, a refresh lands on the same page, and the back button walks back
 * through the pages rather than out of the Admin.
 *
 * `Pagination`, `PaginationContent` and `PaginationItem` are shadcn's and give the nav, list and
 * item semantics. `PaginationLink` and the two controls built on it are deliberately *not* used:
 * they render a bare `<a href>`, which is a document navigation — the browser would fetch and
 * boot the whole Admin again to move one page — so what goes inside each item is a
 * `LinkButton`, which is the router's `Link` wearing the same recipe.
 */
const CURSOR = "after";

/**
 * Where the pages *before* this one are remembered.
 *
 * A cursor says what comes next and can say nothing about what came before — that is what
 * "opaque" costs, and it is not a gap in the implementation. So "previous" is the cursors this
 * browser has already been given, carried in the **history entry's own state**, which the
 * browser stores beside the URL and restores on back and forward. Following next three times
 * and pressing back three times therefore walks the same three pages in reverse.
 *
 * It is deliberately not in the URL beside the cursor. A link a Merchant sends would then carry
 * a trail of somebody else's browsing, and it would grow without bound down a long list.
 *
 * The consequence is honest and visible: **a deep link into page three has no trail**, so it
 * offers "First page" rather than a "Previous" that would silently mean something else.
 */
const TRAIL = "kobai.page-trail";

/** The `after` of each page before this one — `null` for the first page, which has none. */
type Trail = readonly (string | null)[];

function trailOf(state: unknown): Trail {
  if (typeof state !== "object" || state === null || !(TRAIL in state)) return [];
  const trail = (state as Record<string, unknown>)[TRAIL];
  if (!Array.isArray(trail)) return [];
  return trail.filter((entry) => typeof entry === "string" || entry === null);
}

/**
 * The cursor this page was asked for with, straight off the URL.
 *
 * `undefined` for the first page, which is what `GET /admin/products` wants: `after` omitted
 * means the beginning, and sending an empty string would be a cursor kobai never issued.
 *
 * `||` rather than `??`, and the difference is a URL somebody can type: `?after=` present and
 * empty reads as `""`, which is a value, so `??` would let it through and the list would be
 * refused for a cursor this API never issued.
 */
export function usePageCursor(): string | undefined {
  const [params] = useSearchParams();
  return params.get(CURSOR) || undefined;
}

/**
 * Builds the search string for a page: this address, with the cursor moved to a given one.
 *
 * **Everything else in the query string is carried over**, which is what makes paging a
 * *filtered* list mean anything: the Carts list narrows by `?state=` (ADR-0071), and a pager
 * that rebuilt the search out of the cursor alone would answer the second page of the whole
 * table — which looks exactly like paging working, and is a different question being answered.
 * A list with nothing else in its query string is unaffected, because there is nothing to carry.
 *
 * `null` is the first page, which has no cursor: the parameter is **removed** rather than sent
 * empty, since an empty `after` is not a cursor kobai ever issued and is refused as one.
 */
function useSearchFor(): (cursor: string | null) => string {
  const [params] = useSearchParams();

  return (cursor) => {
    const next = new URLSearchParams(params);
    if (cursor === null) next.delete(CURSOR);
    else next.set(CURSOR, cursor);
    const search = next.toString();
    return search === "" ? "" : `?${search}`;
  };
}

/** A control that goes somewhere: one page of the list, and the trail that page inherits. */
function PageLink({
  search,
  trail,
  children,
}: {
  readonly search: string;
  readonly trail: Trail;
  readonly children: ReactNode;
}) {
  const { pathname } = useLocation();

  return (
    <LinkButton
      to={{ pathname, search }}
      state={{ [TRAIL]: trail }}
      variant="outline"
      size="sm"
    >
      {children}
    </LinkButton>
  );
}

/** A control that goes nowhere, because there is nowhere for it to go. */
function NoPage({ children }: { readonly children: ReactNode }) {
  return (
    <Button variant="outline" size="sm" disabled>
      {children}
    </Button>
  );
}

export function Pager({
  nextCursor,
  label,
}: {
  /** What the list answered. **Absent means this is the last page** and nothing follows. */
  readonly nextCursor: string | undefined;
  /** What is being paged, for the accessible name on the nav. */
  readonly label: string;
}) {
  const { state } = useLocation();
  const after = usePageCursor();
  const searchFor = useSearchFor();
  const trail = trailOf(state);
  const previous = trail.length === 0 ? undefined : trail[trail.length - 1];

  // One page, and no other page to reach: two dead controls under a short list say nothing.
  if (nextCursor === undefined && after === undefined) return null;

  return (
    <Pagination aria-label={`${label} pages`} className="mt-4 justify-end">
      <PaginationContent>
        <PaginationItem>
          <PreviousPage after={after} previous={previous} trail={trail} />
        </PaginationItem>
        <PaginationItem>
          {nextCursor === undefined ? (
            <NoPage>
              Next
              <ChevronRightIcon />
            </NoPage>
          ) : (
            <PageLink search={searchFor(nextCursor)} trail={[...trail, after ?? null]}>
              Next
              <ChevronRightIcon />
            </PageLink>
          )}
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

/**
 * Back one page, or back to the beginning, or nowhere — and it says which.
 *
 * The middle case is the one worth reading twice. Arriving by link or by refresh leaves no
 * trail, so the page before this one is genuinely unknown; the first page is the one thing
 * that can be offered truthfully, and it is labelled as itself rather than as "Previous".
 */
function PreviousPage({
  after,
  previous,
  trail,
}: {
  readonly after: string | undefined;
  readonly previous: string | null | undefined;
  readonly trail: Trail;
}) {
  const searchFor = useSearchFor();

  if (previous !== undefined) {
    return (
      <PageLink search={searchFor(previous)} trail={trail.slice(0, -1)}>
        <ChevronLeftIcon />
        Previous
      </PageLink>
    );
  }

  if (after !== undefined) {
    return (
      <PageLink search={searchFor(null)} trail={[]}>
        <ChevronLeftIcon />
        First page
      </PageLink>
    );
  }

  return (
    <NoPage>
      <ChevronLeftIcon />
      Previous
    </NoPage>
  );
}
