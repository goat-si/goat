/* Adapted from apps/web/src/lib/utils.ts@916b5cc — dropped: platform, IDs and unrelated helpers. */
import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";
// Register extra font sizes, background images, z-index layers and durations so tailwind-merge
// does not treat text-2xs or bg-composer-seam-below as colors or keep z-modal beside z-50.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "3xs", "4xs", "5xs", "composer-control", "composer-control-sm", "work-log"],
    },
    classGroups: {
      "bg-image": [{ bg: ["composer-seam-below", "composer-seam-above"] }],
      z: [
        {
          z: [
            "drawer",
            "sheet",
            "player",
            "player-chrome",
            "modal",
            "modal-raised",
            "overlay",
            "toast",
            "panel",
            "popover",
            "tooltip",
            "context-menu",
          ],
        },
      ],
      duration: [{ duration: ["adjust", "enter", "exit"] }],
    },
  },
});

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

