import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { Link } from "react-router";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A link that looks like a button — the router's `Link`, wearing shadcn's `Button` recipe.
 *
 * **Not `<Button render={<Link/>}>`, and that is semantics rather than taste.** Base UI's
 * `Button` given a non-button element adds `role="button"` to it, so the rendered `<a href>` is
 * announced as a button: it is not offered in a screen reader's list of links, and "open" and
 * "next page" stop looking like the navigations they are. shadcn's own `PaginationLink` has
 * exactly that problem, which is why this Admin composes the exported recipe instead — the
 * recipe is exported for this case.
 *
 * The other half is `<a href>` behaviour a `role="button"` cannot have: a middle click opens a
 * new tab, and the status bar shows where it goes before it is clicked.
 */
export function LinkButton({
  variant,
  size,
  className,
  ...link
}: ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>) {
  return <Link {...link} className={cn(buttonVariants({ variant, size }), className)} />;
}
