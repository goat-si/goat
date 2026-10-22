import { GOAT_MARK_INK_BOX } from "@goat/shared/goatMark";

import { cn } from "~/lib/utils";
import { GoatWordmark } from "./GoatWordmark";
import { PixelText } from "./ui/pixel-text";

const INK_VIEWBOX = [
  GOAT_MARK_INK_BOX.x,
  GOAT_MARK_INK_BOX.y,
  GOAT_MARK_INK_BOX.width,
  GOAT_MARK_INK_BOX.height,
].join(" ");

// The mark's ink is as tall as the wordmark's capitals, which are 8/11 of the font size.
const markClassName = { label: "h-2", title: "h-4" } as const;

/** The GOAT mark beside the pixel wordmark. The letters truncate when squeezed. */
export function GoatLogotype({
  size = "title",
  className,
}: {
  size?: keyof typeof markClassName;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label="GOAT"
      className={cn(
        "inline-flex min-w-0 items-center",
        size === "title" ? "gap-2" : "gap-1",
        className,
      )}
    >
      <GoatWordmark
        aria-hidden
        viewBox={INK_VIEWBOX}
        className={cn(markClassName[size], "w-auto shrink-0")}
      />
      <span className="min-w-0 truncate">
        <PixelText size={size}>GOAT</PixelText>
      </span>
    </span>
  );
}
