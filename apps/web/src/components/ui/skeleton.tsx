import * as React from "react";
import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    // A loading placeholder is decoration. Without this it is announced as an
    // empty region, and a screen-reader user hears a list of blank boxes where
    // the content is still loading (WCAG 4.1.3).
    <div
      aria-hidden="true"
      className={cn("skeleton-shimmer rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
