import {
  GOAT_BOT_HEAD_EYES_ORIGIN,
  GOAT_BOT_HEAD_PATH,
  GOAT_BOT_HEAD_SLEEP_MARK_PATH,
  GOAT_BOT_HEAD_STROKE_WIDTH,
  GOAT_BOT_HEAD_VIEWBOX,
  goatBotHeadArt,
  type FaceMotion,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import { useState } from "react";

import { cn } from "~/lib/utils";

/** The face spans 20 grid units, so one unit is 5% of the eyes layer's width. */
// Both layers fill the face box; ! beats icon-size rules such as the rail's [&_svg]:size-5.
const PERCENT_PER_UNIT = 5;
const EYES_ORIGIN = { transformOrigin: GOAT_BOT_HEAD_EYES_ORIGIN };

/**
 * The bot's solid head in the current ink, with eyes in the eye colour that show what the bot is
 * doing. The eyes are their own HTML layer, so a moving face animates only that layer's transform
 * on the compositor.
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
  const art = goatBotHeadArt(state);
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
        viewBox={GOAT_BOT_HEAD_VIEWBOX}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="absolute inset-0 size-full!"
      >
        <path d={GOAT_BOT_HEAD_PATH} fill="currentColor" />
        {art.sleepMark ? (
          <path
            d={GOAT_BOT_HEAD_SLEEP_MARK_PATH}
            stroke="currentColor"
            strokeWidth={GOAT_BOT_HEAD_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
      <span
        ref={animateEyes}
        data-face-eyes
        style={EYES_ORIGIN}
        className="absolute inset-0 text-goat-face-eyes"
      >
        <svg
          aria-hidden
          viewBox={GOAT_BOT_HEAD_VIEWBOX}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="size-full!"
        >
          {art.eyes === "" ? null : <path d={art.eyes} fill="currentColor" />}
          {art.strokes === "" ? null : (
            <path
              d={art.strokes}
              stroke="currentColor"
              strokeWidth={GOAT_BOT_HEAD_STROKE_WIDTH}
              strokeLinecap="round"
            />
          )}
        </svg>
      </span>
    </span>
  );
}
