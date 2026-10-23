import type { SVGProps } from "react";
import {
  GOAT_MARK_HORNS_PATH,
  GOAT_MARK_HORNS_SOFTEN_WIDTH,
  GOAT_MARK_PEAK_PATH,
  GOAT_MARK_PEAK_WIDTH,
  GOAT_MARK_VIEWBOX,
} from "@goat/shared/goatMark";

/** The GOAT mark. Inherits color; size it with layout classes. */
export function GoatWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox={GOAT_MARK_VIEWBOX} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d={GOAT_MARK_HORNS_PATH}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={GOAT_MARK_HORNS_SOFTEN_WIDTH}
        strokeLinejoin="round"
      />
      <path
        d={GOAT_MARK_PEAK_PATH}
        stroke="currentColor"
        strokeWidth={GOAT_MARK_PEAK_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
