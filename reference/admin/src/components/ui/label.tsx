import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn's label, vendored — and the one place the a11y rule has to be told to look away.
 *
 * This is the generic label rather than a use of one: it forwards every `<label>` prop
 * through `...props`, and each caller passes the `htmlFor` naming its own control. The rule
 * cannot see across that boundary, and it is still doing its job at the call sites, which
 * are where a missing `htmlFor` would be a real bug.
 */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the caller passes `htmlFor` — see above.
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
