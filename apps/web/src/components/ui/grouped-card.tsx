import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/**
 * A grouped inset card: one step above the surface it sits on, with a hairline border and a row
 * divider between its children. Settings, the bot's home and its library draw the same card.
 */
export function GroupedCard({
  variant = "grouped",
  divided = true,
  radius = "md",
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: "grouped" | "plain";
  divided?: boolean;
  /** A settings-height group, or the larger corner a panel's cards draw. */
  radius?: "md" | "lg";
}) {
  return (
    <div
      data-slot="grouped-card"
      {...props}
      className={cn(
        "relative overflow-visible text-foreground",
        variant === "grouped"
          ? cn(
              "border border-border/60 bg-card/40 shadow-xs/5",
              radius === "lg" ? "rounded-2xl" : "rounded-xl",
            )
          : "space-y-1",
        variant === "grouped" &&
          divided &&
          "[&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none",
        className,
      )}
    />
  );
}
