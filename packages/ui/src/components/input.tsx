import * as React from "react";

import { cn } from "@arnfar/ui/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // glass-field is recessed, not raised: inputs sit *inside* glass panels, and
        // stacking a second backdrop blur inside one costs a full extra pass to show mush.
        "glass-field placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex h-8 w-full min-w-0 rounded-lg px-2.5 py-1 text-sm transition-[color,box-shadow] outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
