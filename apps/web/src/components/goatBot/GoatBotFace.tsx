import {
  GOAT_BOT_FACE_STROKE_WIDTH,
  GOAT_BOT_SLEEP_MARK_PATH,
  goatBotFaceArt,
  type FaceMotion,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import {
  GOAT_MARK_HORNS_PATH,
  GOAT_MARK_HORNS_SOFTEN_WIDTH,
  GOAT_MARK_VIEWBOX,
} from "@goat/shared/goatMark";
import { useState } from "react";

import { cn } from "~/lib/utils";

/** The face spans 20 grid units, so one unit is 5% of the eyes layer's width. */
const PERCENT_PER_UNIT = 5;

/**
 * The goat mark's horns over a pair of eyes that show what the bot is doing. The eyes are their
 * own HTML layer, so a moving face animates only that layer's transform on the compositor.
 */
export function GoatBotFace({
  state,
  motion = null,
  className,
}: {
  readonly state: GoatBotFaceState;
  /** The eye motion this face runs now; null holds it still. */
  readonly motion?: FaceMotion | null;
  readonly className?: string;
}) {
  // Fade only on a change, never when the face first appears.
  const [firstState] = useState(state);
  const [changed, setChanged] = useState(false);
  if (!changed && state !== firstState) setChanged(true);
  const art = goatBotFaceArt(state);
  const animateEyes = (eyes: HTMLSpanElement | null) => {
    if (eyes === null || motion === null) return;
    const animation = eyes.animate(
      motion.frames.map((frame) => ({
        offset: frame.at,
        transform: `translateX(${frame.x * PERCENT_PER_UNIT}%) scaleY(${frame.scaleY})`,
      })),
      { duration: motion.cycleMs, iterations: Infinity, easing: "linear" },
    );
    return () => animation.cancel();
  };
  return (
    <span
      key={state}
      data-face={state}
      className={cn(
        "relative inline-block",
        changed &&
          "transition-opacity duration-150 starting:opacity-0 motion-reduce:transition-none",
        className,
      )}
    >
      <svg
        aria-hidden
        viewBox={GOAT_MARK_VIEWBOX}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="absolute inset-0 size-full"
      >
        <path
          d={GOAT_MARK_HORNS_PATH}
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={GOAT_MARK_HORNS_SOFTEN_WIDTH}
          strokeLinejoin="round"
        />
        {art.sleepMark ? (
          <path
            d={GOAT_BOT_SLEEP_MARK_PATH}
            stroke="currentColor"
            strokeWidth={GOAT_BOT_FACE_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
      {/* The eyes sit at 67% of the face's height; a blink scales around them. */}
      <span ref={animateEyes} data-face-eyes className="absolute inset-0 origin-[50%_67%]">
        <svg
          aria-hidden
          viewBox={GOAT_MARK_VIEWBOX}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="size-full"
        >
          {art.stroked ? (
            <path
              d={art.eyes}
              stroke="currentColor"
              strokeWidth={GOAT_BOT_FACE_STROKE_WIDTH}
              strokeLinecap="round"
            />
          ) : (
            <path d={art.eyes} fill="currentColor" />
          )}
        </svg>
      </span>
    </span>
  );
}
