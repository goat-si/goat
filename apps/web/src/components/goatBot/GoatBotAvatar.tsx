import { cn } from "~/lib/utils";

import { GoatWordmark } from "../GoatWordmark";

const CIRCLE = { sm: "size-5", md: "size-7", lg: "size-12" } as const;
const MARK = { sm: "size-3.5", md: "size-5", lg: "size-8" } as const;

/** GOAT Bot's face: the goat mark on a theme-aware neutral circle. */
export function GoatBotAvatar({
  size = "md",
  className,
}: {
  readonly size?: keyof typeof CIRCLE;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-goat-avatar-border bg-goat-avatar text-goat-avatar-foreground",
        CIRCLE[size],
        className,
      )}
    >
      <GoatWordmark className={MARK[size]} />
    </span>
  );
}
