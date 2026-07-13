import * as React from "react";

import { cn } from "@arnfar/ui/lib/utils";

/** Lightweight styled native <select> — enough for the Studio's simple pickers
 *  without pulling a full listbox primitive. */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2 text-sm shadow-sm outline-none focus-visible:ring-3 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Select };
