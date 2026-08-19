import { useParams } from "react-router";

/**
 * The `:id` of the route this screen is mounted at.
 *
 * `useParams` answers `string | undefined` for every name, because it cannot know which route
 * is asking — so a detail screen either carries that `undefined` into its query key, its
 * request path and its render, or says once that the route pattern already settled it. This
 * says it once.
 *
 * **It cannot be `undefined` in practice**: react-router matches `products/:id` only when
 * there is a non-empty segment there, and `/products/` matches the list route instead. So a
 * throw here is a programming error — the route pattern lost its `:id`, or this hook was
 * called from a screen that has none — and it names both possibilities rather than rendering
 * a screen that quietly asks kobai for the Product called `undefined`.
 *
 * This is deliberately not a redirect. A redirect would make the mistake invisible in the one
 * place it is cheap to see, and a screen showing "that Product could not be read" for a route
 * that never had an id is a worse answer than a stack trace in a browser console.
 */
export function useRouteId(): string {
  const { id } = useParams();
  if (id === undefined) {
    throw new Error(
      "A detail screen asked for its route's `:id` and the route has none. Either the route in `app.tsx` lost its `:id` segment, or this screen is mounted somewhere it does not belong.",
    );
  }
  return id;
}
