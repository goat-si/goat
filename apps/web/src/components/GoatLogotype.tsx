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

/**
 * The GOAT mark beside the pixel wordmark. The solid mark is drawn 14px tall, a little under the
 * 16px capitals, so it reads the same weight as the one-pixel strokes. The letters truncate when
 * squeezed.
 */
export function GoatLogotype({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="GOAT"
      className={cn("inline-flex min-w-0 items-center gap-2", className)}
    >
      <GoatWordmark aria-hidden viewBox={INK_VIEWBOX} className="h-3.5 w-auto shrink-0" />
      <span className="min-w-0 truncate">
        <PixelText size="title">GOAT</PixelText>
      </span>
    </span>
  );
}
