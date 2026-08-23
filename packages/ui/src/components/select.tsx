import * as React from "react";

import { cn } from "@arnfar/ui/lib/utils";

/** Lightweight styled native <select> — enough for the Studio's simple pickers
 *  without pulling a full listbox primitive. */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        // The dropdown list itself is OS-rendered and stays opaque — only the closed
        // control is glass. That is also how the macOS pop-up button behaves.
        "glass-field focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg px-2 text-sm outline-none focus-visible:ring-3 disabled:opacity-50 [&>optgroup]:bg-popover [&>option]:bg-popover",
        className,
      )}
      {...props}
    />
  );
}

export { Select };
