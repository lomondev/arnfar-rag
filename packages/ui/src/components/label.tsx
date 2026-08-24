import { cn } from "@arnfar/ui/lib/utils";
import type * as React from "react";

/* The control is supplied by the caller — either nested as a child or referenced with
 * htmlFor — so the association cannot be verified from inside this primitive. Callers
 * are linted at their own site, which is where the rule can actually see the pairing. */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: association is the caller's, see above.
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
