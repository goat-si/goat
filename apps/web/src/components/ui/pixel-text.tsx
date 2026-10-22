import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

// Departure Mono draws on an 11px grid; only whole multiples put each glyph pixel on whole
// screen pixels at 1x and 2x. hero steps from 22px on phones to 33px from sm.
const pixelTextSizeClassName = {
  label: "text-pixel-label",
  title: "text-pixel-title",
  display: "text-pixel-display",
  hero: "text-pixel-title sm:text-pixel-display",
} as const;

export type PixelTextSize = keyof typeof pixelTextSizeClassName;

/**
 * Pixel lettering for brand marks, channel labels and hero titles. Not for body text, code or
 * dense UI. The face has one weight; synthesis is off so a bold parent cannot smear the grid.
 */
export function PixelText({
  size = "title",
  className,
  ...props
}: ComponentProps<"span"> & { size?: PixelTextSize }) {
  return (
    <span
      data-slot="pixel-text"
      className={cn(
        "font-pixel font-normal [font-synthesis:none]",
        pixelTextSizeClassName[size],
        className,
      )}
      {...props}
    />
  );
}
