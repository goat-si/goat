import { cn } from "~/lib/utils";

import { T3Wordmark } from "../T3Wordmark";

const CIRCLE = { sm: "size-5", md: "size-7", lg: "size-12" } as const;
const MARK = { sm: "size-3", md: "size-4", lg: "size-7" } as const;

/** GOAT Bot's face: the goat mark on the bot's own color. */
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
        "inline-flex shrink-0 items-center justify-center rounded-full bg-goat-bubble text-goat-bubble-foreground",
        CIRCLE[size],
        className,
      )}
    >
      <T3Wordmark className={MARK[size]} />
    </span>
  );
}
